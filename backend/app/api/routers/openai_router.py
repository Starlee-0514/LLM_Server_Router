"""OpenAI-compatible routing for local, provider, and mesh backends."""
import json
import logging
import threading
import time
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, Request, HTTPException, Depends
from fastapi.responses import StreamingResponse, JSONResponse
from sqlalchemy.orm import Session

from backend.app.core.process_manager import llama_process_manager
from backend.app.core.request_stats import request_stats
from backend.app.core.runtime_settings import get_openai_api_key, get_anthropic_api_key
from backend.app.core.provider_helpers import build_provider_headers, build_provider_chat_url
from backend.app.api.routers.provider_routes import (
    _is_copilot_provider,
    _ensure_fresh_copilot_token,
    _is_github_models_provider,
    _ensure_fresh_github_models_token,
    COPILOT_STATIC_HEADERS,
    ANTIGRAVITY_DEFAULT_MODELS,
    VERTEX_DEFAULT_MODELS,
    _mint_vertex_access_token,
    _AG_CLIENT_ID,
    _AG_CLIENT_SECRET,
    _AG_DEFAULT_PROJECT,
    _vertex_base_url,
    _get_vertex_model_location,
)
from backend.app.database import get_db
from backend.app.models import ProviderEndpoint, ModelRoute, MeshWorker, VirtualModel
from backend.app.services.route_resolver import (
    resolve_candidates,
    DEFAULT_POLICY,
    POLICY_LOCAL_ONLY,
    POLICY_REMOTE_ONLY,
)
from backend.app.services.tool_normalizer import (
    translate_tools,
    translate_tools_for_anthropic,
    validate_tool_call_arguments,
    build_tool_validation_retry_message,
    extract_tool_calls_from_response,
    MAX_TOOL_ITERATIONS,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["openai"])

# 建立重複使用的非同步 HTTP Client
# 預設 5s 超時太短 (Google Gemini 首個 chunk 可能 >5s)，改用寬鬆設定
http_client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=15.0, read=5.0, write=30.0, pool=5.0)
)


# ===========================================================================
# Vertex AI thought-signature cache
# ===========================================================================
# Gemini 2.5+ thinking models attach an opaque ``thought_signature`` to every
# function call they emit.  Subsequent requests that replay those calls in the
# conversation history MUST include the same signature, or Vertex AI returns
# HTTP 400 "missing a thought_signature".
#
# Clients like GitHub Copilot / VS Code speak the Ollama or plain OpenAI
# protocol and therefore drop the ``thought_signature`` field when they send
# the conversation history back to us.  This cache lets the proxy re-inject
# the signatures transparently before forwarding to Vertex AI.

class _ThoughtSigCache:
    """Thread-safe TTL cache (in-memory + JSON file):  tool_call_id → thought_signature.

    Persisted to ``logs/thought_sigs.json`` so the cache survives server restarts.
    Copilot and other clients carry long multi-turn conversations across restarts;
    without persistence every restart would cause Vertex AI 400 errors because the
    thought_signature is missing from the replayed function-call blocks.
    """

    _TTL  = 7 * 24 * 3600   # 7 days – long enough for any realistic conversation
    _FILE = Path("logs/thought_sigs.json")

    def __init__(self) -> None:
        self._lock  = threading.Lock()
        self._store: dict[str, tuple[str, float]] = {}
        self._load()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def put(self, call_id: str, sig: str) -> None:
        if not call_id or not sig:
            return
        expiry = time.time() + self._TTL
        with self._lock:
            self._store[call_id] = (sig, expiry)
        self._save_async()

    def get(self, call_id: str) -> str | None:
        with self._lock:
            entry = self._store.get(call_id)
            if not entry:
                return None
            sig, expiry = entry
            if time.time() > expiry:
                del self._store[call_id]
                return None
            return sig

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------

    def _load(self) -> None:
        """Load persisted cache from disk, dropping expired entries."""
        try:
            if not self._FILE.exists():
                return
            raw: dict[str, list] = json.loads(self._FILE.read_text(encoding="utf-8"))
            now = time.time()
            loaded = 0
            for call_id, (sig, expiry) in raw.items():
                if expiry > now:
                    self._store[call_id] = (sig, expiry)
                    loaded += 1
            if loaded:
                logger.info("[ThoughtSig] Loaded %d cached signatures from %s", loaded, self._FILE)
        except Exception as exc:
            logger.warning("[ThoughtSig] Could not load cache file: %s", exc)

    def _save(self) -> None:
        """Write current (non-expired) cache to disk."""
        try:
            self._FILE.parent.mkdir(parents=True, exist_ok=True)
            now = time.time()
            with self._lock:
                data = {
                    k: list(v)
                    for k, v in self._store.items()
                    if v[1] > now
                }
            self._FILE.write_text(json.dumps(data), encoding="utf-8")
        except Exception as exc:
            logger.warning("[ThoughtSig] Could not save cache file: %s", exc)

    def _save_async(self) -> None:
        """Fire-and-forget background save so put() never blocks a request."""
        threading.Thread(target=self._save, daemon=True).start()

    def _cleanup(self) -> None:
        now = time.time()
        with self._lock:
            expired = [k for k, (_, exp) in self._store.items() if now > exp]
            for k in expired:
                del self._store[k]


_thought_sig_cache = _ThoughtSigCache()


def _cache_thought_sigs_from_response(resp_json: dict) -> None:
    """Extract and cache ``thought_signature`` from a non-streaming Vertex AI response.

    Vertex AI returns the signature inside ``extra_content.google.thought_signature``
    within each tool_call object (not at the top level of the tool_call).
    """
    for choice in (resp_json.get("choices") or []):
        msg = choice.get("message") or {}
        for tc in (msg.get("tool_calls") or []):
            # Primary location: extra_content.google.thought_signature (Vertex AI)
            sig = ((tc.get("extra_content") or {}).get("google") or {}).get("thought_signature")
            # Fallback: top-level thought_signature (future-proofing)
            if not sig:
                sig = tc.get("thought_signature")
            call_id = tc.get("id")
            if sig and call_id:
                _thought_sig_cache.put(call_id, sig)
                logger.debug("[ThoughtSig] Cached signature for tool_call_id=%s", call_id)


def _cache_thought_sigs_from_sse_chunk(chunk: dict) -> None:
    """Extract and cache ``thought_signature`` from a single streaming SSE delta chunk.

    Vertex AI returns the signature inside ``extra_content.google.thought_signature``
    within each tool_call delta object.
    """
    for choice in (chunk.get("choices") or []):
        delta = choice.get("delta") or {}
        for tc in (delta.get("tool_calls") or []):
            sig = ((tc.get("extra_content") or {}).get("google") or {}).get("thought_signature")
            if not sig:
                sig = tc.get("thought_signature")
            call_id = tc.get("id")
            if sig and call_id:
                _thought_sig_cache.put(call_id, sig)
                logger.debug("[ThoughtSig] Cached streaming signature for tool_call_id=%s", call_id)


def _inject_thought_sigs(body: dict) -> dict:
    """Re-inject cached ``thought_signature`` values into assistant tool_calls.

    Vertex AI requires that any function call in the conversation history that
    was originally produced by a thinking model carries its ``thought_signature``
    inside ``extra_content.google.thought_signature``.

    Clients that don't understand this field (e.g. GitHub Copilot / Ollama-compat
    consumers) silently drop it, so we look it up from our local cache and
    restore it before forwarding the request to Vertex AI.
    """
    messages = body.get("messages")
    if not messages:
        return body

    new_messages = []
    injected_any = False
    for msg in messages:
        if msg.get("role") != "assistant":
            new_messages.append(msg)
            continue
        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            new_messages.append(msg)
            continue

        new_tool_calls = []
        for tc in tool_calls:
            # Check if thought_signature already present (either location)
            existing_sig = (
                ((tc.get("extra_content") or {}).get("google") or {}).get("thought_signature")
                or tc.get("thought_signature")
            )
            if existing_sig:
                new_tool_calls.append(tc)
            else:
                call_id = tc.get("id")
                sig = _thought_sig_cache.get(call_id) if call_id else None
                if sig:
                    # Re-inject in the format Vertex AI expects:
                    # tool_call.extra_content.google.thought_signature
                    new_tc = dict(tc)
                    extra_content = dict(new_tc.get("extra_content") or {})
                    google_extra = dict(extra_content.get("google") or {})
                    google_extra["thought_signature"] = sig
                    extra_content["google"] = google_extra
                    new_tc["extra_content"] = extra_content
                    new_tool_calls.append(new_tc)
                    injected_any = True
                    logger.debug("[ThoughtSig] Re-injected signature for tool_call_id=%s", call_id)
                else:
                    new_tool_calls.append(tc)

        new_messages.append({**msg, "tool_calls": new_tool_calls})

    if not injected_any:
        return body
    return {**body, "messages": new_messages}


def _is_missing_thought_sig_error(resp_body: bytes | str) -> bool:
    """Return True if Vertex AI rejected the request due to a missing thought_signature."""
    try:
        text = resp_body.decode("utf-8") if isinstance(resp_body, bytes) else resp_body
        return "thought_signature" in text and "missing" in text
    except Exception:
        return False


def _sanitize_messages_for_vertex(messages: list[dict]) -> list[dict]:
    """Clean up message content so Vertex AI accepts it.

    Vertex AI restrictions (as of 2025):
    * ``tool`` role messages must have a plain string ``content``.
      Copilot sometimes sends a list of content parts that includes
      ``{type: "image_url", ...}`` blocks — those are rejected with HTTP 400.
    * ``user`` role messages DO support inline base64 images via ``image_url``.

    Strategy for list-typed content:
    - If role == "tool":
        1. Keep all ``{type: "text"}`` parts and join their text with newlines.
        2. Drop ``{type: "image_url"}`` parts (and any other unknown types).
        3. Return plain string.
    - If role == "user":
        1. Leave it untouched (pass image_url parts through so Vertex AI can see them).
    """
    cleaned: list[dict] = []
    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content")
        
        if role == "tool" and isinstance(content, list):
            text_parts = [
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            ]
            dropped = sum(
                1 for part in content
                if isinstance(part, dict) and part.get("type") != "text"
            )
            if dropped:
                logger.debug(
                    "[VertexSanitize] Dropped %d non-text content part(s) from tool message",
                    dropped,
                )
            cleaned.append({**msg, "content": "\n".join(text_parts)})
        else:
            cleaned.append(msg)
    return cleaned


def _strip_old_tool_calls(body: dict) -> dict | None:
    """Emergency fallback: rebuild the message list keeping only the last user turn.

    When we cannot inject thought_signatures (e.g. after a server restart), Vertex AI
    returns HTTP 400.  Rather than surfacing a hard error to the user we trim the
    conversation down to just the system prompt (if any) + the latest user message
    and retry.  Context is lost but the conversation can continue.

    Returns None if there is no user message to recover.
    """
    messages = body.get("messages") or []
    system_msgs = [m for m in messages if m.get("role") == "system"]
    # Walk backwards to find the last user message
    last_user = None
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user = m
            break
    if last_user is None:
        return None
    new_messages = system_msgs + [last_user]
    logger.warning(
        "[ThoughtSig] Missing thought_signature — stripping %d old messages, "
        "retrying with only the last user turn.",
        len(messages) - len(new_messages),
    )
    return {**body, "messages": new_messages}


# Vertex AI thinking budget: cap the model's reasoning to prevent multi-minute stalls.
# gemini-3.1-pro-preview (and other thinking models) can reason indefinitely on large
# contexts; setting thinking_budget keeps requests under ~30 seconds in practice.
_VERTEX_THINKING_BUDGET = 8192  # tokens; tune per model if needed


def _prepare_vertex_body(body: dict) -> dict:
    """Prepare a request body for Vertex AI's OpenAI-compatible endpoint.

    1. Sanitizes messages (strips image_url from tool messages).
    2. Re-injects thought_signatures.
    3. Injects thinking_config.thinking_budget to cap reasoning time.
    """
    prepared = translate_tools(body, "openai_compatible")
    prepared["messages"] = _sanitize_messages_for_vertex(prepared.get("messages") or [])
    prepared = _inject_thought_sigs(prepared)
    # Inject thinking budget only if the request doesn't already set one
    if "thinking_config" not in prepared:
        prepared["thinking_config"] = {"thinking_budget": _VERTEX_THINKING_BUDGET}
    return prepared


def _log_completion_usage(body: dict, resp_json: dict, target_url: str, db: Session | None = None, elapsed: float | None = None,
                          model_resolved: str | None = None, provider_name: str | None = None,
                          provider_type: str | None = None, conversation_id: str | None = None,
                          tool_calls_count: int = 0):
    """Log prompt summary and token usage for every successful completion.
    
    When db is provided, also record an auto-benchmark entry and CompletionLog row.
    """
    from backend.app.core.dev_logs import log_completion

    model = body.get("model", "unknown")
    msgs = body.get("messages", [])
    prompt_preview = ""
    for m in reversed(msgs):
        if m.get("role") == "user":
            content = m.get("content") or ""
            if isinstance(content, list):
                # Multimodal content — extract text parts only
                text_parts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
                content = " ".join(filter(None, text_parts))
            prompt_preview = str(content)[:120]
            break
    usage = resp_json.get("usage", {})
    prompt_tokens = usage.get("prompt_tokens") or 0
    completion_tokens = usage.get("completion_tokens") or 0
    total_tokens = usage.get("total_tokens") or 0
    logger.info(
        "[Completion] model=%s prompt_tokens=%s completion_tokens=%s total_tokens=%s target=%s prompt=\"%s\"",
        model, prompt_tokens or "?", completion_tokens or "?", total_tokens or "?", target_url, prompt_preview,
    )

    # Persist to completion log file
    log_completion(model, prompt_tokens, completion_tokens, total_tokens,
                   elapsed or 0, target_url, prompt_preview)

    # Track per-conversation usage for quota enforcement
    if conversation_id:
        request_stats.increment_conversation(conversation_id, total_tokens)

    if db:
        # Write CompletionLog row
        try:
            from backend.app.models import CompletionLog
            latency_ms = round(elapsed * 1000, 1) if elapsed else None
            log_row = CompletionLog(
                model_requested=model,
                model_resolved=model_resolved or model,
                provider_name=provider_name or "",
                provider_type=provider_type or "",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                latency_ms=latency_ms,
                tool_calls_count=tool_calls_count,
                success=1,
                conversation_id=conversation_id,
            )
            db.add(log_row)
            db.commit()
        except Exception as e:
            logger.warning("[CompletionLog] Failed to write log row: %s", e)
            try:
                db.rollback()
            except Exception:
                pass

        # Auto-record as benchmark entry when usage data available
        if elapsed and elapsed > 0 and completion_tokens and completion_tokens > 0:
            try:
                from backend.app.models import BenchmarkRecord
                pp_tps = prompt_tokens / elapsed if prompt_tokens else None
                tg_tps = completion_tokens / elapsed if completion_tokens else None
                record = BenchmarkRecord(
                    model_name=model,
                    model_path=target_url,
                    engine_type="api",
                    n_gpu_layers=0,
                    batch_size=0,
                    ubatch_size=0,
                    ctx_size=0,
                    pp_tokens_per_second=round(pp_tps, 2) if pp_tps else None,
                    tg_tokens_per_second=round(tg_tps, 2) if tg_tps else None,
                    raw_output=f"auto-recorded: prompt={prompt_tokens} completion={completion_tokens} elapsed={elapsed:.2f}s",
                )
                db.add(record)
                db.commit()
                logger.info("[AutoBench] Recorded benchmark for %s: pp=%.1f tg=%.1f t/s", model, pp_tps or 0, tg_tps or 0)
            except Exception as e:
                logger.warning("[AutoBench] Failed to record: %s", e)


def _write_completion_error_log(db: Session | None, model_requested: str, error_msg: str,
                                 provider_name: str | None = None, conversation_id: str | None = None) -> None:
    """Write a failure CompletionLog row."""
    if not db:
        return
    try:
        from backend.app.models import CompletionLog
        log_row = CompletionLog(
            model_requested=model_requested,
            model_resolved="",
            provider_name=provider_name or "",
            provider_type="",
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
            success=0,
            error_message=error_msg[:500],
            conversation_id=conversation_id,
        )
        db.add(log_row)
        db.commit()
    except Exception as e:
        logger.warning("[CompletionLog] Failed to write error log: %s", e)
        try:
            db.rollback()
        except Exception:
            pass


def _convert_openai_messages_to_anthropic(messages: list[dict]) -> tuple[str | None, list[dict]]:
    system_parts: list[str] = []
    converted: list[dict] = []

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if isinstance(content, list):
            text_bits = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text_bits.append(str(item.get("text", "")))
            content_text = "\n".join(text_bits).strip()
        else:
            content_text = str(content)

        if role == "system":
            if content_text:
                system_parts.append(content_text)
            continue

        normalized_role = "assistant" if role == "assistant" else "user"
        converted.append({"role": normalized_role, "content": content_text})

    system_prompt = "\n\n".join(system_parts).strip() if system_parts else None
    return system_prompt, converted


def _convert_anthropic_to_openai(resp: dict, model_name: str) -> dict:
    content_items = resp.get("content", [])
    text_chunks: list[str] = []
    for item in content_items:
        if isinstance(item, dict) and item.get("type") == "text":
            text_chunks.append(str(item.get("text", "")))

    usage = resp.get("usage") or {}
    prompt_tokens = int(usage.get("input_tokens", 0) or 0)
    completion_tokens = int(usage.get("output_tokens", 0) or 0)

    return {
        "id": resp.get("id", f"chatcmpl-anthropic-{int(time.time())}"),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "".join(text_chunks),
                },
                "finish_reason": resp.get("stop_reason") or "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


# ---------------------------------------------------------------------------
# Gemini Cloud Code Assist (cloudcode-pa.googleapis.com) translation layer
# ---------------------------------------------------------------------------

_GEMINI_CLI_HEADERS = {
    "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "X-Goog-Api-Client": "gl-node/22.17.0",
    "Client-Metadata": json.dumps({
        "ideType": "IDE_UNSPECIFIED",
        "platform": "PLATFORM_UNSPECIFIED",
        "pluginType": "GEMINI",
    }),
}


def _extract_gemini_retry_delay(error_text: str, headers: httpx.Headers | None = None) -> float | None:
    """Extract retry delay (seconds) from Gemini error response.

    Checks Retry-After / x-ratelimit-reset-after headers first, then parses
    body patterns like "Your quota will reset after 14s" or
    "retryDelay": "34.07s".  Returns *None* when no hint is found.
    """
    import re

    if headers:
        for hdr in ("retry-after", "x-ratelimit-reset-after"):
            val = headers.get(hdr)
            if val:
                try:
                    return float(val) + 1.0
                except ValueError:
                    pass

    # "Your quota will reset after 18h31m10s" / "reset after 6s"
    m = re.search(r"reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s", error_text, re.I)
    if m:
        h = int(m.group(1) or 0)
        mi = int(m.group(2) or 0)
        s = float(m.group(3))
        return (h * 3600 + mi * 60 + s) + 1.0

    # "Please retry in Xs" / "Please retry in Xms"
    m = re.search(r"retry in ([0-9.]+)(ms|s)", error_text, re.I)
    if m:
        v = float(m.group(1))
        return (v / 1000.0 if m.group(2).lower() == "ms" else v) + 1.0

    # "retryDelay": "34.07s"
    m = re.search(r'"retryDelay":\s*"([0-9.]+)(ms|s)"', error_text, re.I)
    if m:
        v = float(m.group(1))
        return (v / 1000.0 if m.group(2).lower() == "ms" else v) + 1.0

    return None


def _is_gemini_cloudcode_provider(provider: ProviderEndpoint) -> bool:
    """Check if a provider uses Google Cloud Code Assist (needs native Gemini API)."""
    base = (provider.base_url or "").lower()
    name = (provider.name or "").lower()
    has_oauth = (provider.api_key or "").startswith("{")
    # If using cloudcode-pa, always native
    if "cloudcode-pa.googleapis.com" in base:
        return True
    # If using generativelanguage + OAuth tokens, also route via cloudcode-pa
    if "generativelanguage.googleapis.com" in base and has_oauth:
        return True
    if name in {"google_gemini_cli", "google-gemini-cli", "gemini-cli"}:
        return True
    return False


def _is_antigravity_provider(provider: ProviderEndpoint) -> bool:
    """Check if a provider is Google Antigravity (sandbox endpoint)."""
    if provider.provider_type == "google_antigravity":
        return True
    base = (provider.base_url or "").lower()
    if "daily-cloudcode-pa.sandbox.googleapis.com" in base:
        return True
    name = (provider.name or "").lower()
    if name.startswith("google antigravity") or name.startswith("google_antigravity"):
        return True
    return False


def _is_vertex_provider(provider: ProviderEndpoint) -> bool:
    """Check if a provider is Google Vertex AI (service account auth)."""
    if provider.provider_type == "google_vertex":
        return True
    base = (provider.base_url or "").lower()
    if "aiplatform.googleapis.com" in base:
        return True
    return False


async def _build_vertex_headers(provider: ProviderEndpoint, db: Session) -> dict[str, str]:
    """Return Authorization headers for Vertex AI, auto-refreshing the SA token when expired."""
    api_key = provider.api_key or ""
    try:
        token_data = json.loads(api_key)
    except (json.JSONDecodeError, TypeError):
        return {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}

    access_token = token_data.get("access_token", "")
    expires_at = token_data.get("expires_at", 0)
    sa_json = token_data.get("service_account_json")

    if (not expires_at or time.time() >= expires_at) and sa_json:
        try:
            access_token, new_exp = await _mint_vertex_access_token(sa_json)
            token_data["access_token"] = access_token
            token_data["expires_at"] = new_exp
            provider.api_key = json.dumps(token_data)
            db.commit()
            logger.info("Vertex AI token refreshed for provider '%s'", provider.name)
        except Exception as exc:
            logger.warning("Vertex token refresh failed for '%s': %s", provider.name, exc)

    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {access_token}",
    }


def _build_vertex_chat_url(provider: ProviderEndpoint, model_name: str) -> str:
    """Build the Vertex AI chat/completions URL, 根據模型自動選擇適合的部署區域。

    Vertex AI GA 模型（gemini-2.5-*）使用 global 端點；
    Preview / 實驗性模型（gemini-3.x）需要指定區域（如 us-central1）。
    """
    model_location = _get_vertex_model_location(model_name)
    if not model_location:
        # 未登錄在 VERTEX_DEFAULT_MODELS 中，直接使用 provider.base_url
        return build_provider_chat_url(provider.base_url)

    # 嘗試從 api_key JSON 提取 project_idï＼＾
    try:
        token_data = json.loads(provider.api_key or "{}")
        project_id = token_data.get("project_id", "")
    except (json.JSONDecodeError, TypeError):
        project_id = ""

    if not project_id:
        # 無法得知 project_id，回退至 provider.base_url
        logger.warning(
            "[Vertex] Cannot extract project_id for model '%s'; falling back to provider base_url",
            model_name,
        )
        return build_provider_chat_url(provider.base_url)

    base = _vertex_base_url(project_id, model_location)
    logger.debug(
        "[Vertex] model='%s' 路由到區域='%s' url='%s'",
        model_name, model_location, base,
    )
    return f"{base}/chat/completions"


def _is_lmstudio_provider(provider: ProviderEndpoint) -> bool:
    """Return True if this provider points to a local or network LM Studio server."""
    base = (provider.base_url or "").lower().rstrip("/")
    name = (provider.name or "").lower()
    # Port 1234 is LM Studio's default; accept both localhost and any IP/hostname
    if ":1234" in base:
        return True
    if name in {"lm_studio", "lm studio", "lmstudio", "lm-studio"} or name.startswith("lm studio"):
        return True
    return False


def _parse_gemini_sse_response(raw_text: str) -> dict:
    """Parse an SSE stream from streamGenerateContent into a single aggregated
    Gemini response dict (same shape as generateContent).

    Each SSE event looks like:
        data: {"response":{"candidates":[...],"usageMetadata":{...}}}
    We concatenate text parts from all chunks and keep the last usageMetadata.
    """
    import re as _re

    text_parts: list[str] = []
    usage_metadata: dict = {}
    finish_reason = ""
    model_version = ""

    for line in raw_text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue

        resp = chunk.get("response", chunk)
        candidates = resp.get("candidates", [])
        for cand in candidates:
            parts = cand.get("content", {}).get("parts", [])
            for p in parts:
                if "text" in p:
                    text_parts.append(p["text"])
            fr = cand.get("finishReason", "")
            if fr:
                finish_reason = fr

        um = resp.get("usageMetadata")
        if um:
            usage_metadata = um

        mv = resp.get("modelVersion", "")
        if mv:
            model_version = mv

    # Re-assemble into the non-streaming response shape that _convert_gemini_to_openai expects
    result: dict = {
        "response": {
            "candidates": [
                {
                    "content": {"role": "model", "parts": [{"text": "".join(text_parts)}]},
                    "finishReason": finish_reason or "STOP",
                }
            ],
            "usageMetadata": usage_metadata,
        }
    }
    if model_version:
        result["response"]["modelVersion"] = model_version
    return result


def _convert_openai_messages_to_gemini(messages: list[dict]) -> tuple[str | None, list[dict]]:
    """Convert OpenAI messages to Gemini native contents format."""
    system_parts: list[str] = []
    contents: list[dict] = []

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if isinstance(content, list):
            text_bits = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text_bits.append(str(item.get("text", "")))
            content_text = "\n".join(text_bits).strip()
        else:
            content_text = str(content)

        if role == "system":
            if content_text:
                system_parts.append(content_text)
            continue

        gemini_role = "model" if role == "assistant" else "user"
        contents.append({
            "parts": [{"text": content_text}],
            "role": gemini_role,
        })

    system_prompt = "\n\n".join(system_parts).strip() if system_parts else None
    return system_prompt, contents


def _convert_gemini_to_openai(resp: dict, model_name: str) -> dict:
    """Convert Gemini native generateContent response to OpenAI chat completion format."""
    # Cloud Code wraps response in a "response" key
    inner = resp.get("response", resp)
    candidates = inner.get("candidates", [])
    text_out = ""
    finish_reason = "stop"
    if candidates:
        parts = candidates[0].get("content", {}).get("parts", [])
        text_bits = [p.get("text", "") for p in parts if "text" in p]
        text_out = "".join(text_bits)
        fr = candidates[0].get("finishReason", "")
        if fr == "MAX_TOKENS":
            finish_reason = "length"
        elif fr == "SAFETY":
            finish_reason = "content_filter"

    usage = inner.get("usageMetadata", {})
    prompt_tokens = int(usage.get("promptTokenCount", 0))
    completion_tokens = int(usage.get("candidatesTokenCount", 0))

    return {
        "id": f"chatcmpl-gemini-{int(time.time())}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text_out},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


async def _discover_gemini_project(access_token: str) -> str:
    """Discover the user's Cloud Code Assist project ID."""
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "User-Agent": "google-api-nodejs-client/9.15.1",
        "X-Goog-Api-Client": "gl-node/22.17.0",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
            headers=headers,
            json={
                "metadata": {
                    "ideType": "IDE_UNSPECIFIED",
                    "platform": "PLATFORM_UNSPECIFIED",
                    "pluginType": "GEMINI",
                },
            },
        )
    if resp.status_code != 200:
        logger.warning("loadCodeAssist failed: %s %s", resp.status_code, resp.text[:300])
        return ""
    data = resp.json()
    return data.get("cloudaicompanionProject", "")


async def _proxy_gemini_cloudcode(
    provider: ProviderEndpoint, db: Session, body: dict
) -> JSONResponse:
    """Proxy an OpenAI-format request through Cloud Code Assist (native Gemini API).

    When stream=True, we open a true streaming connection to Gemini's SSE
    endpoint and translate each chunk on-the-fly to OpenAI SSE format so the
    client sees tokens as they arrive (matching pi-agent behaviour).
    """
    import asyncio

    t0 = time.time()
    model_name = body.get("model", "")
    messages = body.get("messages", [])
    max_tokens = body.get("max_tokens") or body.get("max_completion_tokens") or 8192
    # Gemini Cloud Code caps maxOutputTokens at 65536
    max_tokens = min(int(max_tokens), 65536)
    temperature = body.get("temperature")
    is_streaming = body.get("stream", False)

    # Refresh OAuth token
    headers_result = await _build_oauth_provider_headers(provider, db)
    access_token = headers_result.get("Authorization", "").replace("Bearer ", "")

    if not access_token:
        return JSONResponse(status_code=401, content={"error": {"message": "No access token available for Gemini Cloud Code"}})

    # Get or discover project ID
    try:
        token_data = json.loads(provider.api_key or "{}")
    except (json.JSONDecodeError, TypeError):
        token_data = {}

    project_id = token_data.get("project_id", "")
    if not project_id:
        project_id = await _discover_gemini_project(access_token)
        if project_id:
            token_data["project_id"] = project_id
            provider.api_key = json.dumps(token_data)
            db.commit()
            logger.info("Discovered Gemini Cloud Code project: %s", project_id)

    # Convert messages
    system_prompt, contents = _convert_openai_messages_to_gemini(messages)

    # Build native Gemini request
    generation_config: dict = {}
    if max_tokens:
        generation_config["maxOutputTokens"] = int(max_tokens)
    if temperature is not None:
        generation_config["temperature"] = temperature

    gemini_request: dict = {"contents": contents}
    if system_prompt:
        gemini_request["systemInstruction"] = {"parts": [{"text": system_prompt}]}
    if generation_config:
        gemini_request["generationConfig"] = generation_config

    gemini_body: dict = {
        "model": model_name,
        "request": gemini_request,
        "userAgent": "llm-server-router",
        "requestId": f"router-{uuid.uuid4().hex}-{model_name}",
    }
    if project_id:
        gemini_body["project"] = project_id

    target_url = "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    req_headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        **_GEMINI_CLI_HEADERS,
    }

    # ------------------------------------------------------------------
    # Helper: make the upstream request.  For streaming we need the httpx
    # response kept open (stream=True); for non-streaming a normal post.
    # ------------------------------------------------------------------
    _MAX_RETRIES = 5
    _MAX_RETRY_WAIT = 120  # seconds

    async def _make_request_with_retry(*, stream: bool):
        """Return an httpx.Response.  Caller must close if stream=True."""
        for attempt in range(_MAX_RETRIES + 1):
            try:
                if stream:
                    req = http_client.build_request(
                        "POST", target_url, headers=req_headers, json=gemini_body,
                        timeout=httpx.Timeout(connect=15.0, read=180.0, write=30.0, pool=5.0),
                    )
                    resp = await http_client.send(req, stream=True)
                else:
                    resp = await http_client.post(
                        target_url, headers=req_headers, json=gemini_body, timeout=180.0,
                    )
            except httpx.RequestError as e:
                logger.error("Gemini Cloud Code request error: %s", e)
                if attempt < _MAX_RETRIES:
                    wait = min(2 ** attempt * 2, _MAX_RETRY_WAIT)
                    logger.warning("Network error, retrying in %ds (attempt %d/%d)", wait, attempt + 1, _MAX_RETRIES)
                    await asyncio.sleep(wait)
                    continue
                return None, f"Failed to reach Gemini Cloud Code: {e}"

            # On 429 — read body so we can parse retry delay, then retry
            if resp.status_code == 429 and attempt < _MAX_RETRIES:
                if stream:
                    error_text = (await resp.aread()).decode(errors="replace")
                    await resp.aclose()
                else:
                    error_text = resp.text
                server_delay = _extract_gemini_retry_delay(error_text, resp.headers)
                wait = server_delay if server_delay else 2 ** attempt * 2
                wait = min(wait, _MAX_RETRY_WAIT)
                logger.warning(
                    "Gemini rate limited (429), retrying in %.1fs (attempt %d/%d, server_hint=%s)",
                    wait, attempt + 1, _MAX_RETRIES,
                    f"{server_delay:.1f}s" if server_delay else "none",
                )
                await asyncio.sleep(wait)
                continue

            # Transient server errors
            if resp.status_code in (500, 502, 503, 504) and attempt < _MAX_RETRIES:
                if stream:
                    await resp.aread()
                    await resp.aclose()
                wait = min(2 ** attempt * 2, _MAX_RETRY_WAIT)
                logger.warning("Gemini server error %d, retrying in %ds (attempt %d/%d)", resp.status_code, wait, attempt + 1, _MAX_RETRIES)
                await asyncio.sleep(wait)
                continue

            # Non-retryable error
            if resp.status_code != 200:
                if stream:
                    err_body = (await resp.aread()).decode(errors="replace")
                    await resp.aclose()
                else:
                    err_body = resp.text
                logger.warning("Gemini Cloud Code error %s: %s", resp.status_code, err_body[:500])
                try:
                    err = json.loads(err_body)
                except Exception:
                    err = {"error": {"message": err_body[:1000]}}
                return None, err  # caller returns JSONResponse

            return resp, None  # success

        # All retries exhausted — signal the last failure reason
        return None, {"error": {"message": "Gemini Cloud Code: max retries exceeded (rate limited)"}, "_status": 429}

    # ==================================================================
    # STREAMING PATH — true chunk-by-chunk SSE translation
    #
    # Pi-agent observation: Gemini Cloud Code sometimes returns HTTP 200
    # but the SSE stream is completely empty (0 completion tokens).  This
    # is especially common with large prompts (skills, long context).  Pi
    # agent retries up to MAX_EMPTY_STREAM_RETRIES times before giving up.
    # We replicate the same behaviour here.
    # ==================================================================
    _MAX_EMPTY_STREAM_RETRIES = 2
    _EMPTY_STREAM_BASE_DELAY_MS = 500  # ms, doubles each attempt

    if is_streaming:
        # We may need multiple attempts if Gemini returns empty streams.
        # Because we can only start yielding SSE data to the client once,
        # we must collect + retry *before* entering the generator.
        collected_lines: list[str] = []  # raw SSE "data: ..." lines with content
        final_usage: dict = {}
        final_finish_reason = "stop"

        for empty_attempt in range(_MAX_EMPTY_STREAM_RETRIES + 1):
            if empty_attempt > 0:
                backoff_s = (_EMPTY_STREAM_BASE_DELAY_MS / 1000.0) * (2 ** (empty_attempt - 1))
                logger.warning(
                    "[Gemini] Empty stream on attempt %d, retrying in %.1fs",
                    empty_attempt, backoff_s,
                )
                await asyncio.sleep(backoff_s)

            response, err = await _make_request_with_retry(stream=True)
            if response is None:
                if isinstance(err, dict):
                    status = err.pop("_status", 502)
                    return JSONResponse(status_code=status, content=err)
                return JSONResponse(status_code=502, content={"error": {"message": str(err)}})

            # Consume the SSE stream and check if it has actual content
            has_content = False
            collected_lines = []
            final_usage = {}
            final_finish_reason = "stop"

            try:
                async for raw_line in response.aiter_lines():
                    line = raw_line.strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[len("data:"):].strip()
                    if not payload or payload == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue

                    resp_data = chunk.get("response", chunk)
                    candidates = resp_data.get("candidates", [])
                    for cand in candidates:
                        parts = cand.get("content", {}).get("parts", [])
                        for p in parts:
                            text = p.get("text")
                            if text:
                                has_content = True
                                collected_lines.append(text)
                        fr = cand.get("finishReason", "")
                        if fr:
                            if fr == "MAX_TOKENS":
                                final_finish_reason = "length"
                            elif fr == "SAFETY":
                                final_finish_reason = "content_filter"
                            else:
                                final_finish_reason = "stop"

                    um = resp_data.get("usageMetadata")
                    if um:
                        final_usage["prompt_tokens"] = int(um.get("promptTokenCount", 0))
                        final_usage["completion_tokens"] = int(um.get("candidatesTokenCount", 0))
                        final_usage["total_tokens"] = int(um.get("totalTokenCount", 0))
            finally:
                await response.aclose()

            if has_content:
                break  # Got real content, stop retrying

        if not collected_lines:
            logger.warning("[Gemini] Empty response after %d attempts", _MAX_EMPTY_STREAM_RETRIES + 1)
            return JSONResponse(
                status_code=502,
                content={"error": {"message": "Gemini Cloud Code returned an empty response after retries"}},
            )

        # Now yield the collected content as OpenAI SSE chunks to the client
        _t0 = t0
        _body = body
        _chunk_id = f"chatcmpl-gemini-{int(time.time())}"
        _created = int(time.time())

        async def generate_stream():
            try:
                # Role header chunk
                role_chunk = {
                    "id": _chunk_id,
                    "object": "chat.completion.chunk",
                    "created": _created,
                    "model": model_name,
                    "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}}],
                }
                yield f"data: {json.dumps(role_chunk)}\n\n".encode("utf-8")

                # Yield each collected text part
                for text in collected_lines:
                    delta_chunk = {
                        "id": _chunk_id,
                        "object": "chat.completion.chunk",
                        "created": _created,
                        "model": model_name,
                        "choices": [{"index": 0, "delta": {"content": text}}],
                    }
                    yield f"data: {json.dumps(delta_chunk)}\n\n".encode("utf-8")

                # Finish reason chunk
                stop_chunk = {
                    "id": _chunk_id,
                    "object": "chat.completion.chunk",
                    "created": _created,
                    "model": model_name,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": final_finish_reason}],
                }
                yield f"data: {json.dumps(stop_chunk)}\n\n".encode("utf-8")

                # Usage chunk
                if final_usage:
                    usage_chunk = {
                        "id": _chunk_id,
                        "object": "chat.completion.chunk",
                        "created": _created,
                        "model": model_name,
                        "choices": [],
                        "usage": final_usage,
                    }
                    yield f"data: {json.dumps(usage_chunk)}\n\n".encode("utf-8")

                yield b"data: [DONE]\n\n"
            finally:
                # Record completion log after stream ends
                elapsed = time.time() - _t0
                try:
                    from backend.app.database import SessionLocal as _SessionLocal
                    new_db = _SessionLocal()
                    try:
                        openai_resp_for_log = {
                            "usage": final_usage or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                        }
                        _log_completion_usage(
                            _body, openai_resp_for_log, target_url,
                            db=new_db, elapsed=elapsed,
                        )
                    finally:
                        new_db.close()
                except Exception as exc:
                    logger.warning("[AutoBench] Gemini streaming record failed: %s", exc)

        return StreamingResponse(generate_stream(), media_type="text/event-stream")

    # ==================================================================
    # NON-STREAMING PATH — collect full response then return JSON
    # Same empty-stream retry logic as streaming path.
    # ==================================================================
    for empty_attempt in range(_MAX_EMPTY_STREAM_RETRIES + 1):
        if empty_attempt > 0:
            backoff_s = (_EMPTY_STREAM_BASE_DELAY_MS / 1000.0) * (2 ** (empty_attempt - 1))
            logger.warning(
                "[Gemini] Empty response on attempt %d (non-stream), retrying in %.1fs",
                empty_attempt, backoff_s,
            )
            await asyncio.sleep(backoff_s)

        response, err = await _make_request_with_retry(stream=False)
        if response is None:
            if isinstance(err, dict):
                status = err.pop("_status", 502)
                return JSONResponse(status_code=status, content=err)
            return JSONResponse(status_code=502, content={"error": {"message": str(err)}})

        # Parse SSE stream into a single aggregated response
        gemini_resp = _parse_gemini_sse_response(response.text)
        openai_resp = _convert_gemini_to_openai(gemini_resp, model_name)

        # Check for empty response
        content_text = openai_resp.get("choices", [{}])[0].get("message", {}).get("content", "")
        if content_text:
            break  # Got real content

    elapsed = time.time() - t0
    _log_completion_usage(body, openai_resp, target_url, db=db, elapsed=elapsed)

    if not content_text:
        logger.warning("[Gemini] Empty response after %d attempts (non-stream)", _MAX_EMPTY_STREAM_RETRIES + 1)
        return JSONResponse(
            status_code=502,
            content={"error": {"message": "Gemini Cloud Code returned an empty response after retries"}},
        )

    return JSONResponse(status_code=200, content=openai_resp)


_ANTIGRAVITY_VERSION = "1.18.4"
_ANTIGRAVITY_ENDPOINT_FALLBACKS = [
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://autopush-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
]


async def _build_antigravity_headers(provider: ProviderEndpoint, db: Session) -> tuple[dict[str, str], str, str]:
    """Build headers for Antigravity and return (headers, access_token, project_id).

    Auto-refreshes the token using the AG hardcoded credentials.
    """
    api_key = provider.api_key or ""
    try:
        token_data = json.loads(api_key)
    except (json.JSONDecodeError, TypeError):
        return {}, "", ""

    access_token = token_data.get("access_token", "")
    refresh_token = token_data.get("refresh_token", "")
    project_id = token_data.get("project_id", _AG_DEFAULT_PROJECT)
    expires_at = token_data.get("expires_at", 0)

    # Refresh if expired
    if (not expires_at or time.time() >= expires_at) and refresh_token:
        ag_cid = token_data.get("ag_client_id", _AG_CLIENT_ID)
        ag_csec = token_data.get("ag_client_secret", _AG_CLIENT_SECRET)
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    "https://oauth2.googleapis.com/token",
                    data={
                        "client_id": ag_cid,
                        "client_secret": ag_csec,
                        "refresh_token": refresh_token,
                        "grant_type": "refresh_token",
                    },
                )
            if resp.status_code == 200:
                payload = resp.json()
                new_access = payload.get("access_token", "")
                if new_access:
                    access_token = new_access
                    token_data["access_token"] = new_access
                    new_exp = int(payload.get("expires_in", 3600))
                    token_data["expires_at"] = time.time() + new_exp - 300
                    if payload.get("refresh_token"):
                        token_data["refresh_token"] = payload["refresh_token"]
                    provider.api_key = json.dumps(token_data)
                    db.commit()
                    logger.info("Antigravity OAuth token refreshed")
        except Exception as e:
            logger.warning("Antigravity token refresh failed: %s", e)

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": f"antigravity/{_ANTIGRAVITY_VERSION} linux/x86_64",
    }
    return headers, access_token, project_id


async def _proxy_antigravity(
    provider: ProviderEndpoint, db: Session, body: dict
) -> JSONResponse:
    """Proxy an OpenAI-format request through Antigravity (sandbox Cloud Code Assist)."""
    import asyncio

    t0 = time.time()
    model_name = body.get("model", "")
    messages = body.get("messages", [])
    max_tokens = body.get("max_tokens") or body.get("max_completion_tokens") or 8192
    max_tokens = min(int(max_tokens), 65536)
    temperature = body.get("temperature")
    is_streaming = body.get("stream", False)

    req_headers, access_token, project_id = await _build_antigravity_headers(provider, db)
    if not access_token:
        return JSONResponse(status_code=401, content={"error": {"message": "No access token available for Antigravity"}})

    # Convert messages
    system_prompt, contents = _convert_openai_messages_to_gemini(messages)

    # Build native Gemini request
    generation_config: dict = {}
    if max_tokens:
        generation_config["maxOutputTokens"] = int(max_tokens)
    if temperature is not None:
        generation_config["temperature"] = temperature

    gemini_request: dict = {"contents": contents}
    if system_prompt:
        gemini_request["systemInstruction"] = {"parts": [{"text": system_prompt}]}
    if generation_config:
        gemini_request["generationConfig"] = generation_config

    gemini_body: dict = {
        "model": model_name,
        "request": gemini_request,
        "requestType": "agent",
        "userAgent": "antigravity",
        "requestId": f"agent-{uuid.uuid4().hex}-{model_name}",
    }
    if project_id:
        gemini_body["project"] = project_id

    # Use fallback endpoints
    base_url = (provider.base_url or "").rstrip("/")
    endpoints = [base_url] if base_url else _ANTIGRAVITY_ENDPOINT_FALLBACKS

    _MAX_RETRIES = 3
    _MAX_RETRY_WAIT = 120

    async def _make_ag_request(*, stream: bool):
        last_err = None
        ep_idx = 0
        for attempt in range(_MAX_RETRIES + 1):
            ep = endpoints[ep_idx] if ep_idx < len(endpoints) else endpoints[-1]
            target_url = f"{ep}/v1internal:streamGenerateContent?alt=sse"
            try:
                if stream:
                    req = http_client.build_request(
                        "POST", target_url, headers=req_headers, json=gemini_body,
                        timeout=httpx.Timeout(connect=15.0, read=180.0, write=30.0, pool=5.0),
                    )
                    resp = await http_client.send(req, stream=True)
                else:
                    resp = await http_client.post(
                        target_url, headers=req_headers, json=gemini_body, timeout=180.0,
                    )
            except httpx.RequestError as e:
                if attempt < _MAX_RETRIES:
                    await asyncio.sleep(min(2 ** attempt * 2, _MAX_RETRY_WAIT))
                    continue
                return None, f"Failed to reach Antigravity: {e}"

            if (resp.status_code in (403, 404)) and ep_idx < len(endpoints) - 1:
                if stream:
                    await resp.aread()
                    await resp.aclose()
                ep_idx += 1
                continue

            if resp.status_code == 429 and attempt < _MAX_RETRIES:
                if stream:
                    err_text = (await resp.aread()).decode(errors="replace")
                    await resp.aclose()
                else:
                    err_text = resp.text
                delay = _extract_gemini_retry_delay(err_text, resp.headers) or 2 ** attempt * 2
                delay = min(delay, _MAX_RETRY_WAIT)
                logger.warning("Antigravity 429, retry in %.1fs", delay)
                await asyncio.sleep(delay)
                if ep_idx < len(endpoints) - 1:
                    ep_idx += 1
                continue

            if resp.status_code in (500, 502, 503, 504) and attempt < _MAX_RETRIES:
                if stream:
                    await resp.aread()
                    await resp.aclose()
                await asyncio.sleep(min(2 ** attempt * 2, _MAX_RETRY_WAIT))
                continue

            if resp.status_code != 200:
                if stream:
                    err = (await resp.aread()).decode(errors="replace")
                    await resp.aclose()
                else:
                    err = resp.text
                try:
                    err = json.loads(err)
                except Exception:
                    err = {"error": {"message": err[:1000]}}
                return None, err

            return resp, None
        return None, {"error": {"message": "Antigravity max retries exceeded"}, "_status": 429}

    # Reuse the Gemini SSE parsing logic from _proxy_gemini_cloudcode
    _MAX_EMPTY = 2
    _EMPTY_DELAY_MS = 500

    if is_streaming:
        collected_lines: list[str] = []
        final_usage: dict = {}
        final_finish = "stop"

        for ea in range(_MAX_EMPTY + 1):
            if ea > 0:
                await asyncio.sleep((_EMPTY_DELAY_MS / 1000.0) * (2 ** (ea - 1)))
            response, err = await _make_ag_request(stream=True)
            if response is None:
                if isinstance(err, dict):
                    st = err.pop("_status", 502)
                    return JSONResponse(status_code=st, content=err)
                return JSONResponse(status_code=502, content={"error": {"message": str(err)}})

            has_content = False
            collected_lines = []
            final_usage = {}
            final_finish = "stop"
            try:
                async for raw_line in response.aiter_lines():
                    line = raw_line.strip()
                    if not line.startswith("data:"):
                        continue
                    payload_str = line[len("data:"):].strip()
                    if not payload_str or payload_str == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(payload_str)
                    except json.JSONDecodeError:
                        continue
                    resp_data = chunk.get("response", chunk)
                    candidates = resp_data.get("candidates", [])
                    for cand in candidates:
                        parts = cand.get("content", {}).get("parts", [])
                        for p in parts:
                            text = p.get("text")
                            if text:
                                has_content = True
                                collected_lines.append(text)
                        fr = cand.get("finishReason", "")
                        if fr == "MAX_TOKENS":
                            final_finish = "length"
                        elif fr == "SAFETY":
                            final_finish = "content_filter"
                    um = resp_data.get("usageMetadata")
                    if um:
                        final_usage = {
                            "prompt_tokens": int(um.get("promptTokenCount", 0)),
                            "completion_tokens": int(um.get("candidatesTokenCount", 0)),
                            "total_tokens": int(um.get("totalTokenCount", 0)),
                        }
            finally:
                await response.aclose()
            if has_content:
                break

        if not collected_lines:
            return JSONResponse(status_code=502, content={"error": {"message": "Antigravity returned empty response after retries"}})

        _chunk_id = f"chatcmpl-antigravity-{int(time.time())}"
        _created = int(time.time())
        _t0 = t0
        _body = body

        async def ag_generate_stream():
            try:
                role_chunk = {"id": _chunk_id, "object": "chat.completion.chunk", "created": _created, "model": model_name, "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}}]}
                yield f"data: {json.dumps(role_chunk)}\n\n".encode("utf-8")
                for text in collected_lines:
                    dc = {"id": _chunk_id, "object": "chat.completion.chunk", "created": _created, "model": model_name, "choices": [{"index": 0, "delta": {"content": text}}]}
                    yield f"data: {json.dumps(dc)}\n\n".encode("utf-8")
                sc = {"id": _chunk_id, "object": "chat.completion.chunk", "created": _created, "model": model_name, "choices": [{"index": 0, "delta": {}, "finish_reason": final_finish}]}
                yield f"data: {json.dumps(sc)}\n\n".encode("utf-8")
                if final_usage:
                    uc = {"id": _chunk_id, "object": "chat.completion.chunk", "created": _created, "model": model_name, "choices": [], "usage": final_usage}
                    yield f"data: {json.dumps(uc)}\n\n".encode("utf-8")
                yield b"data: [DONE]\n\n"
            finally:
                elapsed = time.time() - _t0
                try:
                    from backend.app.database import SessionLocal as _SL
                    ndb = _SL()
                    try:
                        _log_completion_usage(_body, {"usage": final_usage or {}}, "antigravity", db=ndb, elapsed=elapsed)
                    finally:
                        ndb.close()
                except Exception:
                    pass

        return StreamingResponse(ag_generate_stream(), media_type="text/event-stream")

    # Non-streaming
    for ea in range(_MAX_EMPTY + 1):
        if ea > 0:
            await asyncio.sleep((_EMPTY_DELAY_MS / 1000.0) * (2 ** (ea - 1)))
        response, err = await _make_ag_request(stream=False)
        if response is None:
            if isinstance(err, dict):
                st = err.pop("_status", 502)
                return JSONResponse(status_code=st, content=err)
            return JSONResponse(status_code=502, content={"error": {"message": str(err)}})
        gemini_resp = _parse_gemini_sse_response(response.text)
        openai_resp = _convert_gemini_to_openai(gemini_resp, model_name)
        content_text = openai_resp.get("choices", [{}])[0].get("message", {}).get("content", "")
        if content_text:
            break

    elapsed = time.time() - t0
    _log_completion_usage(body, openai_resp, "antigravity", db=db, elapsed=elapsed)
    if not content_text:
        return JSONResponse(status_code=502, content={"error": {"message": "Antigravity returned empty response"}})
    return JSONResponse(status_code=200, content=openai_resp)


def _provider_headers(provider: ProviderEndpoint) -> dict[str, str]:
    headers = build_provider_headers(provider.api_key or "", provider.extra_headers or "")
    return headers


async def _build_oauth_provider_headers(provider: ProviderEndpoint, db: Session) -> dict[str, str]:
    """Build headers for OAuth providers (e.g. Google Gemini) with auto-refresh.

    Uses expires_at tracking (with 5-minute buffer, same as pi-agent) to avoid
    refreshing on every request. Only refreshes when the token is actually expired.
    """
    api_key = provider.api_key or ""
    headers = {"Content-Type": "application/json"}

    try:
        token_data = json.loads(api_key)
    except (json.JSONDecodeError, TypeError):
        headers["Authorization"] = f"Bearer {api_key}"
        return headers

    access_token = token_data.get("access_token", "")
    refresh_token = token_data.get("refresh_token", "")
    expires_at = token_data.get("expires_at", 0)

    # Only refresh if token is expired (or no expires_at tracked yet → always refresh once)
    needs_refresh = not expires_at or time.time() >= expires_at

    if needs_refresh and refresh_token:
        try:
            from backend.app.api.routers.provider_routes import _get_google_creds
            # Antigravity uses its own credentials
            is_ag = provider.provider_type == "google_antigravity" or token_data.get("ag_client_id")
            if is_ag:
                client_id = token_data.get("ag_client_id", _AG_CLIENT_ID)
                client_secret = token_data.get("ag_client_secret", _AG_CLIENT_SECRET)
            else:
                client_id, client_secret = _get_google_creds()
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    "https://oauth2.googleapis.com/token",
                    data={
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "refresh_token": refresh_token,
                        "grant_type": "refresh_token",
                    },
                )
            if resp.status_code == 200:
                payload = resp.json()
                new_access = payload.get("access_token", "")
                new_expires_in = int(payload.get("expires_in", 3600))
                if new_access:
                    access_token = new_access
                    token_data["access_token"] = new_access
                    # 5-minute buffer before actual expiry (same as pi-agent)
                    token_data["expires_at"] = time.time() + new_expires_in - 300
                    # Google may rotate refresh_token
                    if payload.get("refresh_token"):
                        token_data["refresh_token"] = payload["refresh_token"]
                    provider.api_key = json.dumps(token_data)
                    db.commit()
                    logger.info("Google OAuth token refreshed (expires_in=%ds)", new_expires_in)
            else:
                logger.warning("Google OAuth token refresh HTTP %d: %s", resp.status_code, resp.text[:200])
        except Exception as e:
            logger.warning("Google OAuth token refresh failed: %s", e)

    headers["Authorization"] = f"Bearer {access_token}"

    # Apply extra_headers (e.g. x-goog-api-key if set)
    if provider.extra_headers:
        try:
            parsed = json.loads(provider.extra_headers)
            if isinstance(parsed, dict):
                headers.update({str(k): str(v) for k, v in parsed.items()})
        except Exception:
            pass

    return headers


def _find_model_route(db: Session, model_name: str) -> tuple[ModelRoute | None, ProviderEndpoint | None]:
    """Return the first matching (route, provider) pair."""
    matches = _find_all_model_routes(db, model_name)
    if matches:
        return matches[0]
    return None, None


def _find_all_model_routes(db: Session, model_name: str) -> list[tuple[ModelRoute, ProviderEndpoint]]:
    """Return ALL matching (route, provider) pairs, ordered by priority ASC.

    This allows the caller to fall through to the next route when the
    first one returns 429 / 502 / 503.
    """
    rules = (
        db.query(ModelRoute)
        .filter(ModelRoute.enabled == 1)
        .order_by(ModelRoute.priority.asc(), ModelRoute.created_at.asc())
        .all()
    )
    results: list[tuple[ModelRoute, ProviderEndpoint]] = []
    for rule in rules:
        matched = False
        if rule.match_type == "exact" and model_name == rule.match_value:
            matched = True
        elif rule.match_type == "prefix" and model_name.startswith(rule.match_value):
            matched = True
        # Also match by route_name (the user-facing alias)
        elif rule.route_name and model_name == rule.route_name:
            matched = True
        if not matched:
            continue

        provider = (
            db.query(ProviderEndpoint)
            .filter(ProviderEndpoint.id == rule.provider_id, ProviderEndpoint.enabled == 1)
            .first()
        )
        if provider:
            results.append((rule, provider))

    return results


def _find_mesh_worker_for_model(db: Session, model_name: str) -> MeshWorker | None:
    workers = db.query(MeshWorker).filter(MeshWorker.status == "online").order_by(MeshWorker.updated_at.desc()).all()
    for worker in workers:
        try:
            models = json.loads(worker.models_json or "[]")
        except Exception:
            models = []
        if model_name in models:
            return worker
    return None


def _find_provider_by_known_models(db: Session, model_name: str) -> ProviderEndpoint | None:
    """Check if any enabled provider has this model in its known catalog.

    This allows models from GitHub Copilot or Gemini CLI providers to be
    used even without explicit route table entries.
    """
    from backend.app.api.routers.provider_routes import (
        GITHUB_COPILOT_DEFAULT_MODELS,
        GEMINI_CLI_DEFAULT_MODELS,
        GITHUB_MODELS_DEFAULT_MODELS,
        ANTIGRAVITY_DEFAULT_MODELS,
        VERTEX_DEFAULT_MODELS,
    )

    providers = (
        db.query(ProviderEndpoint)
        .filter(ProviderEndpoint.enabled == 1)
        .all()
    )
    for prov in providers:
        base_url = (prov.base_url or "").rstrip("/").lower()
        prov_name = (prov.name or "").strip().lower()

        catalog: list[dict[str, any]] = []
        # Check by name first (more specific), then by base_url
        if prov_name in {"github_models", "github-models"}:
            catalog = GITHUB_MODELS_DEFAULT_MODELS
        elif prov_name in {"github_copilot", "github-copilot"} or "githubcopilot.com" in base_url:
            catalog = GITHUB_COPILOT_DEFAULT_MODELS + GITHUB_MODELS_DEFAULT_MODELS
        elif "cloudcode-pa.googleapis.com" in base_url or prov_name in {"google_gemini_cli", "google-gemini-cli", "gemini-cli"}:
            catalog = GEMINI_CLI_DEFAULT_MODELS
        elif "generativelanguage.googleapis.com" in base_url or prov_name in {"google_gemini_openai"}:
            catalog = GEMINI_CLI_DEFAULT_MODELS
        elif prov.provider_type == "google_antigravity" or "daily-cloudcode-pa.sandbox.googleapis.com" in base_url or prov_name.startswith("google antigravity") or prov_name.startswith("google_antigravity"):
            catalog = ANTIGRAVITY_DEFAULT_MODELS
        elif prov.provider_type == "google_vertex" or "aiplatform.googleapis.com" in base_url:
            catalog = VERTEX_DEFAULT_MODELS

        for item in catalog:
            if item.get("id") == model_name:
                if item.get("context_length"):
                    prov.context_length = item["context_length"]
                return prov

    return None


async def _proxy_openai_compatible(
    target_url: str,
    headers: dict[str, str],
    body: dict,
    db: Session | None = None,
    model_resolved: str | None = None,
    provider_name: str | None = None,
    provider_type: str | None = None,
    conversation_id: str | None = None,
    tool_calls_count: int = 0,
    cache_thought_sigs: bool = False,
):
    is_streaming = body.get("stream", False)
    t0 = time.time()
    if is_streaming:
        import asyncio as _asyncio
        # Inject stream_options so the upstream returns usage in the final SSE chunk
        streaming_body = dict(body)
        streaming_body.setdefault("stream_options", {})["include_usage"] = True

        # 串流超時：連線 15s，每個 chunk 之間最多等 600s
        # 600s (10 min) read timeout is necessary for large-context local models:
        # a 12k-token prefill on a 27B Q4 Vulkan model can take several minutes
        # before the first streaming token arrives.  Remote providers (Vertex, Copilot)
        # are unaffected because they respond within seconds.
        _stream_timeout = httpx.Timeout(connect=15.0, read=600.0, write=30.0, pool=5.0)
        req = http_client.build_request(
            "POST", target_url, headers=headers, json=streaming_body,
            timeout=_stream_timeout,
        )
        # NOTE: do NOT await http_client.send() here.
        # For large contexts Vertex AI takes 10-20s to send even the HTTP 200 headers.
        # If we block here, FastAPI cannot return 200 OK to Copilot, so Copilot times out
        # and shows "Response contained no choices" before we even start streaming.
        # Instead, connect inside generate() and send SSE keep-alive comments while waiting.

        # Capture closure vars for post-stream recording
        _t0 = t0
        _body = body
        _target_url = target_url
        _model_resolved = model_resolved
        _provider_name = provider_name
        _provider_type = provider_type
        _conversation_id = conversation_id
        _tool_calls_count = tool_calls_count
        _cache_thought_sigs = cache_thought_sigs
        # Track whether the *original client* explicitly requested usage in the stream.
        # We unconditionally inject stream_options.include_usage=True upstream for logging,
        # but we only forward the usage chunk back to clients that asked for it.
        # (Copilot and some other clients crash on choices:[] chunks, so we keep them hidden.)
        _client_wants_usage = bool((body.get("stream_options") or {}).get("include_usage"))
        _usage: dict = {}

        async def generate():
            _sent_any_choice = False

            # --- Phase 1: connect to upstream, keep client alive with SSE comments ---
            # Use wait_for+shield so we exit the keepalive loop the moment the
            # connection is ready, without burning an extra 3-second sleep cycle.
            connect_task = _asyncio.ensure_future(http_client.send(req, stream=True))
            try:
                while not connect_task.done():
                    try:
                        await _asyncio.wait_for(_asyncio.shield(connect_task), timeout=3.0)
                        break  # connected before timeout
                    except _asyncio.TimeoutError:
                        # Still waiting — send keep-alive to reset client read-timeout
                        yield b": keepalive\n\n"
                    except Exception as conn_exc:
                        # connect_task raised a non-asyncio exception (e.g. httpx.ReadTimeout,
                        # httpx.ConnectError) while we were inside wait_for(shield(…)).
                        # asyncio.shield propagates it through wait_for without converting
                        # to TimeoutError, so it would normally escape the generator and
                        # surface as an ASGI 500.  Catch it here and return a clean SSE error.
                        logger.warning(
                            "[Proxy] Upstream connection error during streaming connect: %s %s",
                            type(conn_exc).__name__, conn_exc,
                        )
                        err = {"error": {"message": str(conn_exc),
                                         "type": "connection_error", "code": 503}}
                        yield f"data: {json.dumps(err)}\n\ndata: [DONE]\n\n".encode()
                        return
            except _asyncio.CancelledError:
                connect_task.cancel()
                return

            try:
                response = connect_task.result()
            except Exception as exc:
                err = {"error": {"message": str(exc), "type": "connection_error", "code": 503}}
                yield f"data: {json.dumps(err)}\n\ndata: [DONE]\n\n".encode()
                return

            if response.status_code == 429:
                # Rate-limited: wait briefly and tell the client to retry.
                # We can't retry transparently here (streaming already started),
                # so surface a clear error message.
                err_body = await response.aread()
                await response.aclose()
                wait_hint = 30
                logger.warning("[Vertex] 429 Rate Limit from %s — retry in %ds", target_url, wait_hint)
                err_json = {"error": {"message": f"Vertex AI rate limit (429). Please wait ~{wait_hint}s and try again.", "code": 429, "type": "rate_limit_error"}}
                yield f"data: {json.dumps(err_json)}\n\ndata: [DONE]\n\n".encode()
                return

            if response.status_code != 200:
                err_body = await response.aread()
                await response.aclose()
                logger.warning("Upstream error %s from %s: %s",
                               response.status_code, target_url, err_body[:500])
                try:
                    err_json = json.loads(err_body)
                except Exception:
                    err_json = {"error": {"message": err_body.decode(errors="replace")[:1000]}}
                yield f"data: {json.dumps(err_json)}\n\ndata: [DONE]\n\n".encode()
                return

            # --- Phase 2: stream chunks from upstream to client ---
            try:
                async for line in response.aiter_lines():  # noqa: E501
                    if line.startswith("data: ") and line != "data: [DONE]":
                        try:
                            d = json.loads(line[6:])
                            has_choices = bool(d.get("choices"))
                            has_usage = "usage" in d and d["usage"] is not None

                            if has_usage:
                                _usage.update(d["usage"])

                            # Cache thought_signatures from Vertex AI thinking models
                            if _cache_thought_sigs:
                                _cache_thought_sigs_from_sse_chunk(d)

                            # Never forward chunks with empty choices.
                            # We inject stream_options.include_usage so we can record
                            # usage internally, but Copilot (and many other clients)
                            # crash on any chunk where choices is [] or missing.
                            if not has_choices:
                                continue  # drop: pure usage / filter-results chunk

                            # Ensure every streaming choice has a `delta` field.
                            # Vertex AI omits `delta` on finish-only chunks (e.g. when
                            # all tokens were used for reasoning).  Copilot treats
                            # choices without `delta` as invalid and reports "no choices".
                            choices = d.get("choices") or []
                            patched = False
                            for ch in choices:
                                if "delta" not in ch:
                                    ch["delta"] = {"content": "", "role": "assistant"}
                                    patched = True
                            if patched:
                                line = "data: " + json.dumps(d)

                            # Strip usage before forwarding if it's bundled with choices
                            # (Vertex AI anomaly: sends choices+usage in one chunk).
                            if has_choices and has_usage:
                                d_fwd = dict(d)
                                del d_fwd["usage"]
                                _sent_any_choice = True
                                yield f"data: {json.dumps(d_fwd)}\n\n".encode("utf-8")
                                continue

                            _sent_any_choice = True

                        except (json.JSONDecodeError, KeyError):
                            pass
                    # If client explicitly requested include_usage, inject a usage chunk
                    # right before [DONE] so they can see token counts.
                    if line == "data: [DONE]" and _client_wants_usage and _usage:
                        usage_chunk = {
                            "id": f"chatcmpl-usage-{int(time.time())}",
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": _body.get("model", ""),
                            "choices": [],
                            "usage": _usage,
                        }
                        yield f"data: {json.dumps(usage_chunk)}\n\n".encode("utf-8")
                    yield (line + "\n").encode("utf-8")
            except (httpx.TimeoutException, httpx.TransportError) as stream_exc:
                # Mid-stream network error (e.g. model server timed out between tokens,
                # or TCP connection was reset).  Catch it here so the ASGI layer never
                # sees an unhandled exception — instead send a clean SSE error event.
                logger.warning(
                    "[Proxy] Upstream stream interrupted (%s): %s",
                    type(stream_exc).__name__, stream_exc,
                )
                if not _sent_any_choice:
                    err = {"error": {"message": f"Upstream stream error: {stream_exc}",
                                     "type": "stream_error", "code": 503}}
                    yield f"data: {json.dumps(err)}\n\ndata: [DONE]\n\n".encode()
                else:
                    yield b"data: [DONE]\n\n"
                return
            finally:
                # If Vertex AI returned nothing useful (safety block, pure reasoning, etc.)
                # synthesize a minimal valid chunk so clients don't crash.
                if not _sent_any_choice:
                    fallback = (
                        'data: {"choices":[{"delta":{"content":"","role":"assistant"},'
                        '"finish_reason":"stop","index":0}],"object":"chat.completion.chunk"}'
                    )
                    yield (fallback + "\n\n").encode("utf-8")
                    yield b"data: [DONE]\n\n"
                await response.aclose()
                # Record benchmark/completion log after stream ends
                completion_tokens = _usage.get("completion_tokens") or 0
                elapsed = time.time() - _t0
                if completion_tokens > 0 and elapsed > 0:
                    try:
                        from backend.app.database import SessionLocal as _SessionLocal
                        new_db = _SessionLocal()
                        try:
                            _log_completion_usage(
                                _body, {"usage": _usage}, _target_url,
                                db=new_db, elapsed=elapsed,
                                model_resolved=_model_resolved,
                                provider_name=_provider_name,
                                provider_type=_provider_type,
                                conversation_id=_conversation_id,
                                tool_calls_count=_tool_calls_count,
                            )
                        finally:
                            new_db.close()
                    except Exception as exc:
                        logger.warning("[AutoBench] Streaming record failed: %s", exc)

        return StreamingResponse(generate(), media_type="text/event-stream")

    try:
        response = await http_client.post(target_url, headers=headers, json=body, timeout=120.0)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        # Network-level error on the non-streaming path (connection refused, timeout, etc.).
        # Return a clean JSON 502 so callers always get structured JSON, never a raw 500.
        logger.warning("[Proxy] Upstream connection error (non-streaming): %s %s", type(exc).__name__, exc)
        return JSONResponse(
            status_code=502,
            content={"error": {"message": str(exc), "type": "connection_error", "code": 502}},
        )
    elapsed = time.time() - t0
    if response.status_code != 200:
        logger.warning("Upstream error %s from %s: %s", response.status_code, target_url, response.text[:500])
    else:
        resp_json = response.json()
        if cache_thought_sigs:
            _cache_thought_sigs_from_response(resp_json)
        _log_completion_usage(
            body, resp_json, target_url, db=db, elapsed=elapsed,
            model_resolved=model_resolved, provider_name=provider_name,
            provider_type=provider_type, conversation_id=conversation_id,
            tool_calls_count=tool_calls_count,
        )
        return JSONResponse(status_code=response.status_code, content=resp_json)
    return JSONResponse(status_code=response.status_code, content=response.json())


@router.get("/models")
async def list_models(db: Session = Depends(get_db)):
    """Return aggregated model list from local processes, mesh workers, virtual models, and routes."""
    statuses = llama_process_manager.get_all_status()

    data = []
    for st in statuses:
        if st["is_running"]:
            data.append({
                "id": st["identifier"],
                "object": "model",
                "created": int(st.get("uptime_seconds", 0)),
                "owned_by": "local",
            })

    # Online mesh workers' advertised models
    workers = db.query(MeshWorker).filter(MeshWorker.status == "online").all()
    for worker in workers:
        try:
            models = json.loads(worker.models_json or "[]")
        except Exception:
            models = []
        for model_name in models:
            data.append({
                "id": model_name,
                "object": "model",
                "created": 0,
                "owned_by": f"mesh:{worker.node_name}",
            })

    # Explicit route table
    rules = db.query(ModelRoute).filter(ModelRoute.enabled == 1).all()
    for rule in rules:
        exposed_id = rule.route_name or rule.target_model or rule.match_value
        model_entry: dict = {
            "id": exposed_id,
            "object": "model",
            "created": 0,
            "owned_by": "provider-route",
        }
        if rule.context_length:
            model_entry["context_window"] = rule.context_length
        data.append(model_entry)

    # Virtual model aliases (stable logical IDs)
    virtual_models = db.query(VirtualModel).filter(VirtualModel.enabled == 1).all()
    for vm in virtual_models:
        data.append({
            "id": vm.model_id,
            "object": "model",
            "created": 0,
            "owned_by": "virtual",
            "description": vm.display_name or vm.description,
        })

    # Deduplicate by model id
    dedup = {item["id"]: item for item in data}
    data = list(dedup.values())

    data.append({"id": "gpt-4o", "object": "model", "created": 0, "owned_by": "openai"})
    data.append({"id": "claude-3-7-sonnet-latest", "object": "model", "created": 0, "owned_by": "anthropic"})

    return {"object": "list", "data": data}


@router.post("/chat/completions")
async def chat_completions(request: Request, db: Session = Depends(get_db)):
    """Handle OpenAI-compatible chat completions and route by rule/provider."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    model_name = body.get("model", "")
    if not model_name:
        raise HTTPException(status_code=400, detail="Missing 'model' in request body")

    # Strip Ollama ':latest' tag — providers/routes use bare model names
    if model_name.endswith(":latest"):
        model_name = model_name.removesuffix(":latest")
        body = {**body, "model": model_name}

    # Read route policy from header (override) or fall back to default
    policy = request.headers.get("x-route-policy", "").strip() or DEFAULT_POLICY
    if policy not in {"local_first", "cheapest", "fastest", "highest_quality", "local_only", "remote_only"}:
        policy = DEFAULT_POLICY

    conversation_id = request.headers.get("x-conversation-id", "").strip() or None

    # Resolve virtual model alias first
    vm = db.query(VirtualModel).filter(VirtualModel.model_id == model_name, VirtualModel.enabled == 1).first()
    if vm:
        try:
            hints = json.loads(vm.routing_hints_json or "{}")
            if hints.get("preferred_policy"):
                policy = hints["preferred_policy"]
        except Exception:
            pass

    # Use the route resolver to get a priority-ordered list of candidates for mesh workers.
    # (Local process and provider routing still uses legacy code paths below for compatibility
    #  with OAuth token refresh, special provider types, etc.)
    resolver_candidates = resolve_candidates(db, model_name, body, policy)
    # Separate mesh candidates for use in section 2
    mesh_candidates = [c for c in resolver_candidates if c.backend_type == "mesh"]

    # 1) Explicit model route table has highest priority.
    #    Try ALL matching routes in priority order; fall through on 429/502/503.
    _FALLBACK_STATUS_CODES = {429, 502, 503}
    all_routes = _find_all_model_routes(db, model_name)
    last_fallback_response = None

    if all_routes:
        logger.info(
            "Routing model '%s' with %d candidate route(s) under policy '%s'",
            model_name,
            len(all_routes),
            policy,
        )

    for _route_idx, (rule, provider) in enumerate(all_routes):
        is_last_route = _route_idx == len(all_routes) - 1

        routed_model = rule.target_model or rule.match_value or model_name
        # For prefix routes with no explicit target_model, strip the matched
        # prefix so "github-copilot/gpt-5-mini" → "gpt-5-mini" upstream.
        if not rule.target_model and rule.match_type == "prefix" and model_name.startswith(rule.match_value):
            routed_model = model_name[len(rule.match_value):]
        route_body = {**body, "model": routed_model} if routed_model != model_name else body

        if policy == POLICY_REMOTE_ONLY and provider.provider_type == "local_process":
            # Skip local process if policy says remote only
            continue

        logger.info(
            "Route attempt %d/%d: route='%s' provider='%s' type='%s' model='%s'",
            _route_idx + 1,
            len(all_routes),
            rule.route_name,
            provider.name,
            provider.provider_type,
            routed_model,
        )

        result = None  # will hold the response from this route attempt

        if provider.provider_type == "local_process":
            port = llama_process_manager.get_router_port_for_model(routed_model)
            fallback_identifier: str | None = None
            if port is None:
                # Fallback: the route alias (e.g. 'Local_Model_62k') may not match the
                # process-manager identifier (e.g. 'GLM-4.7-Flash-Q8_0').  When there
                # is at least one running local process, route to the best-match one.
                #
                # Priority:
                #   1. Exact/substring match already tried above (port is None → no match)
                #   2. If exactly ONE process is running → use it unconditionally.
                #   3. If multiple processes running → use the first one but log a warning
                #      so the user knows to set target_model for deterministic behaviour.
                fallback = llama_process_manager.get_first_running_process()
                if fallback:
                    fallback_identifier, port = fallback
                    logger.warning(
                        "[LocalProcess] Route '%s': no running process matched '%s'; "
                        "falling back to '%s' on port %d. "
                        "Set 'target_model' in the route to the process identifier to "
                        "avoid this ambiguity.",
                        rule.route_name, routed_model, fallback_identifier, port,
                    )
            if port is None:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        f"Local model '{routed_model}' is not currently running and "
                        f"no fallback local process is available. "
                        f"Please start the model first or check the route configuration."
                    ),
                )
            request_stats.increment_local()
            target_url = f"http://127.0.0.1:{port}/v1/chat/completions"
            result = await _proxy_openai_compatible(
                target_url, {"Content-Type": "application/json"}, route_body, db=db,
                model_resolved=fallback_identifier or routed_model,
                provider_name=provider.name, provider_type="local_process",
                conversation_id=conversation_id,
            )

        elif provider.provider_type == "google_antigravity":
            request_stats.increment_remote()
            result = await _proxy_antigravity(provider, db, route_body)

        elif provider.provider_type == "google_vertex":
            request_stats.increment_remote()
            fwd_body = _prepare_vertex_body(route_body)
            headers = await _build_vertex_headers(provider, db)
            vertex_url = _build_vertex_chat_url(provider, routed_model)
            result = await _proxy_openai_compatible(
                vertex_url, headers, fwd_body, db=db,
                model_resolved=routed_model, provider_name=provider.name,
                provider_type=provider.provider_type, conversation_id=conversation_id,
                cache_thought_sigs=True,
            )
            # --- Fallback: missing thought_signature after server restart ---
            if (
                result is not None
                and getattr(result, "status_code", None) == 400
                and _is_missing_thought_sig_error(getattr(result, "body", b""))
            ):
                stripped = _strip_old_tool_calls(fwd_body)
                if stripped is not None:
                    result = await _proxy_openai_compatible(
                        vertex_url, headers, stripped, db=db,
                        model_resolved=routed_model, provider_name=provider.name,
                        provider_type=provider.provider_type, conversation_id=conversation_id,
                        cache_thought_sigs=True,
                    )

        elif provider.provider_type == "openai_compatible":
            if not provider.base_url:
                raise HTTPException(status_code=500, detail=f"Provider '{provider.name}' base_url is empty")
            request_stats.increment_remote()

            # Translate tools for the provider if needed
            fwd_body = translate_tools(route_body, provider.provider_type)

            # Antigravity: use sandbox endpoint with Antigravity headers (legacy — provider_type == openai_compatible but detected by URL/name)
            if _is_antigravity_provider(provider):
                result = await _proxy_antigravity(provider, db, route_body)

            # Gemini Cloud Code: use native API translation
            elif _is_gemini_cloudcode_provider(provider):
                result = await _proxy_gemini_cloudcode(provider, db, route_body)

            elif _is_copilot_provider(provider):
                copilot_token = await _ensure_fresh_copilot_token(provider, db)
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {copilot_token}",
                    **COPILOT_STATIC_HEADERS,
                }
                result = await _proxy_openai_compatible(
                    build_provider_chat_url(provider.base_url), headers, fwd_body, db=db,
                    model_resolved=routed_model, provider_name=provider.name,
                    provider_type=provider.provider_type, conversation_id=conversation_id,
                )

            elif _is_github_models_provider(provider):
                gh_token = await _ensure_fresh_github_models_token(provider, db)
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {gh_token}",
                    **COPILOT_STATIC_HEADERS,
                }
                result = await _proxy_openai_compatible(
                    build_provider_chat_url(provider.base_url), headers, fwd_body, db=db,
                    model_resolved=routed_model, provider_name=provider.name,
                    provider_type=provider.provider_type, conversation_id=conversation_id,
                )

            elif (provider.api_key or "").startswith("{"):
                headers = await _build_oauth_provider_headers(provider, db)
                result = await _proxy_openai_compatible(
                    build_provider_chat_url(provider.base_url), headers, fwd_body, db=db,
                    model_resolved=routed_model, provider_name=provider.name,
                    provider_type=provider.provider_type, conversation_id=conversation_id,
                )

            else:
                result = await _proxy_openai_compatible(
                    build_provider_chat_url(provider.base_url), _provider_headers(provider), fwd_body, db=db,
                    model_resolved=routed_model, provider_name=provider.name,
                    provider_type=provider.provider_type, conversation_id=conversation_id,
                )

        elif provider.provider_type == "anthropic":
            if route_body.get("stream", False):
                raise HTTPException(status_code=501, detail="Anthropic streaming conversion is not implemented yet")
            messages = route_body.get("messages")
            if not isinstance(messages, list):
                raise HTTPException(status_code=400, detail="Invalid or missing 'messages'")

            api_key = provider.api_key or get_anthropic_api_key()
            if not api_key:
                raise HTTPException(status_code=500, detail=f"Anthropic API key for provider '{provider.name}' is missing")

            system_prompt, converted_messages = _convert_openai_messages_to_anthropic(messages)

            openai_tools = route_body.get("tools")
            anthropic_tools = translate_tools_for_anthropic(openai_tools) if openai_tools else None

            anthropic_payload = {
                "model": routed_model,
                "messages": converted_messages,
                "max_tokens": int(route_body.get("max_tokens") or 1024),
                "temperature": route_body.get("temperature", 0.7),
            }
            if system_prompt:
                anthropic_payload["system"] = system_prompt
            if anthropic_tools:
                anthropic_payload["tools"] = anthropic_tools

            request_stats.increment_remote()
            target_url = (provider.base_url.rstrip("/") if provider.base_url else "https://api.anthropic.com") + "/v1/messages"
            t0_ant = time.time()
            try:
                response = await http_client.post(
                    target_url,
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json=anthropic_payload,
                    timeout=60.0,
                )
                payload = response.json()
                if response.status_code >= 400:
                    result = JSONResponse(status_code=response.status_code, content=payload)
                else:
                    openai_resp = _convert_anthropic_to_openai(payload, routed_model)
                    _log_completion_usage(
                        body, openai_resp, target_url, db=db,
                        elapsed=time.time() - t0_ant,
                        model_resolved=routed_model, provider_name=provider.name,
                        provider_type="anthropic", conversation_id=conversation_id,
                        tool_calls_count=len(openai_tools) if openai_tools else 0,
                    )
                    result = JSONResponse(status_code=200, content=openai_resp)
            except httpx.RequestError as e:
                logger.error("連線至 Anthropic provider 失敗: %s", e)
                result = JSONResponse(status_code=502, content={"error": {"message": f"Bad Gateway: Unable to reach Anthropic provider: {e}"}})

        # --- Fallback decision ---
        if result is not None:
            # Check if this is a retryable error and we have more routes to try
            should_fallback = False
            if not is_last_route and isinstance(result, JSONResponse):
                result_status = result.status_code
                if result_status in _FALLBACK_STATUS_CODES:
                    should_fallback = True

            if should_fallback:
                next_route, next_provider = all_routes[_route_idx + 1]
                logger.info(
                    "Route switch: '%s' -> '%s' (provider '%s' -> '%s') due to status=%d (%d/%d)",
                    rule.route_name,
                    next_route.route_name,
                    provider.name,
                    next_provider.name,
                    result.status_code,
                    _route_idx + 1,
                    len(all_routes),
                )
                last_fallback_response = result
                continue
            logger.info(
                "Route success on attempt %d/%d: route='%s' provider='%s' status=%d",
                _route_idx + 1,
                len(all_routes),
                rule.route_name,
                provider.name,
                result.status_code if isinstance(result, JSONResponse) else 200,
            )
            return result

    # If all routes were exhausted with retryable errors, return the last error
    if last_fallback_response is not None:
        logger.info(
            "All %d candidate routes exhausted for model '%s'; returning last fallback status=%d",
            len(all_routes),
            model_name,
            last_fallback_response.status_code,
        )
        return last_fallback_response

    # 2) Mesh worker auto-discovery — use resolver's scored candidates first.
    if mesh_candidates:
        best = mesh_candidates[0]
        request_stats.increment_remote()
        return await _proxy_openai_compatible(
            best.target_url, best.headers, body, db=db,
            model_resolved=model_name, provider_name=best.display_name,
            provider_type="mesh", conversation_id=conversation_id,
        )
    # Fallback: unscored discovery (handles stale / newly-joined workers)
    worker = _find_mesh_worker_for_model(db, model_name)
    if worker:
        headers = {"Content-Type": "application/json"}
        if worker.api_token:
            headers["Authorization"] = f"Bearer {worker.api_token}"
        request_stats.increment_remote()
        target_url = worker.base_url.rstrip("/") + "/v1/chat/completions"
        return await _proxy_openai_compatible(
            target_url, headers, body, db=db,
            model_resolved=model_name, provider_name=f"mesh:{worker.node_name}",
            provider_type="mesh", conversation_id=conversation_id,
        )

    # 2.5) Auto-discovery: check if any configured provider's known model catalog
    # contains this model, even if no explicit route has been created.
    provider = _find_provider_by_known_models(db, model_name)
    if provider:
        request_stats.increment_remote()
        fwd_body_cat = translate_tools(body, provider.provider_type)

        # Antigravity: use sandbox endpoint
        if _is_antigravity_provider(provider):
            return await _proxy_antigravity(provider, db, body)

        # Vertex AI: service-account token auth
        if _is_vertex_provider(provider):
            headers = await _build_vertex_headers(provider, db)
            fwd_body_cat = _prepare_vertex_body(body)
            return await _proxy_openai_compatible(
                _build_vertex_chat_url(provider, model_name), headers, fwd_body_cat, db=db,
                model_resolved=model_name, provider_name=provider.name,
                provider_type=provider.provider_type, conversation_id=conversation_id,
                cache_thought_sigs=True,
            )

        # Gemini Cloud Code: use native API translation
        if _is_gemini_cloudcode_provider(provider):
            return await _proxy_gemini_cloudcode(provider, db, body)

        target_url = build_provider_chat_url(provider.base_url or "")

        if _is_copilot_provider(provider):
            copilot_token = await _ensure_fresh_copilot_token(provider, db)
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {copilot_token}",
                **COPILOT_STATIC_HEADERS,
            }
            return await _proxy_openai_compatible(
                target_url, headers, fwd_body_cat, db=db,
                model_resolved=model_name, provider_name=provider.name,
                provider_type=provider.provider_type, conversation_id=conversation_id,
            )

        if _is_github_models_provider(provider):
            gh_token = await _ensure_fresh_github_models_token(provider, db)
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {gh_token}",
                **COPILOT_STATIC_HEADERS,
            }
            return await _proxy_openai_compatible(
                target_url, headers, fwd_body_cat, db=db,
                model_resolved=model_name, provider_name=provider.name,
                provider_type=provider.provider_type, conversation_id=conversation_id,
            )

        if (provider.api_key or "").startswith("{"):
            headers = await _build_oauth_provider_headers(provider, db)
            return await _proxy_openai_compatible(
                target_url, headers, fwd_body_cat, db=db,
                model_resolved=model_name, provider_name=provider.name,
                provider_type=provider.provider_type, conversation_id=conversation_id,
            )

        return await _proxy_openai_compatible(
            target_url, _provider_headers(provider), fwd_body_cat, db=db,
            model_resolved=model_name, provider_name=provider.name,
            provider_type=provider.provider_type, conversation_id=conversation_id,
        )

    # 3) Backward-compatible default routing.
    is_remote_openai = model_name.startswith("gpt-") or model_name.startswith("o1-")
    is_remote_anthropic = model_name.startswith("claude-")
    if is_remote_openai:
        openai_key = get_openai_api_key()
        if not openai_key:
            raise HTTPException(status_code=500, detail="OpenAI API Key 未設定")
        request_stats.increment_remote()
        return await _proxy_openai_compatible(
            "https://api.openai.com/v1/chat/completions",
            {"Authorization": f"Bearer {openai_key}", "Content-Type": "application/json"},
            body,
            db=db,
            model_resolved=model_name, provider_name="openai",
            provider_type="openai_compatible", conversation_id=conversation_id,
        )

    if is_remote_anthropic:
        anthropic_key = get_anthropic_api_key()
        if not anthropic_key:
            raise HTTPException(status_code=500, detail="Anthropic API Key 未設定")
        if body.get("stream", False):
            raise HTTPException(status_code=501, detail="Anthropic streaming conversion is not implemented yet")

        messages = body.get("messages")
        if not isinstance(messages, list):
            raise HTTPException(status_code=400, detail="Invalid or missing 'messages'")

        system_prompt, converted_messages = _convert_openai_messages_to_anthropic(messages)

        # Translate tools for Anthropic default routing too
        openai_tools_def = body.get("tools")
        anthropic_tools_def = translate_tools_for_anthropic(openai_tools_def) if openai_tools_def else None

        anthropic_payload = {
            "model": model_name,
            "messages": converted_messages,
            "max_tokens": int(body.get("max_tokens") or 1024),
            "temperature": body.get("temperature", 0.7),
        }
        if system_prompt:
            anthropic_payload["system"] = system_prompt
        if anthropic_tools_def:
            anthropic_payload["tools"] = anthropic_tools_def

        request_stats.increment_remote()
        t0_ant_def = time.time()
        try:
            response = await http_client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": anthropic_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json=anthropic_payload,
                timeout=60.0,
            )
            payload = response.json()
            if response.status_code >= 400:
                return JSONResponse(status_code=response.status_code, content=payload)
            openai_resp_def = _convert_anthropic_to_openai(payload, model_name)
            _log_completion_usage(
                body, openai_resp_def, "https://api.anthropic.com/v1/messages", db=db,
                elapsed=time.time() - t0_ant_def,
                model_resolved=model_name, provider_name="anthropic",
                provider_type="anthropic", conversation_id=conversation_id,
                tool_calls_count=len(openai_tools_def) if openai_tools_def else 0,
            )
            return JSONResponse(status_code=200, content=openai_resp_def)
        except httpx.RequestError as e:
            logger.error("連線至 Anthropic 失敗: %s", e)
            raise HTTPException(status_code=502, detail="Bad Gateway: Unable to reach Anthropic")

    port = llama_process_manager.get_router_port_for_model(model_name)
    if port is None:
        # Fallback: try the first running process when name doesn't match
        fallback = llama_process_manager.get_first_running_process()
        if fallback:
            fallback_id, port = fallback
            logger.warning(
                "[LocalProcess] No route or exact match for '%s'; "
                "falling back to running process '%s' on port %d.",
                model_name, fallback_id, port,
            )
    if port is None:
        raise HTTPException(
            status_code=503,
            detail=f"No provider route or running local model found for '{model_name}'",
        )

    request_stats.increment_local()
    target_url = f"http://127.0.0.1:{port}/v1/chat/completions"

    try:
        return await _proxy_openai_compatible(
            target_url, {"Content-Type": "application/json"}, body, db=db,
            model_resolved=model_name, provider_name="local",
            provider_type="local_process", conversation_id=conversation_id,
        )
    except httpx.RequestError as e:
        logger.error(f"連線至目標 {target_url} 失敗: {e}")
        raise HTTPException(status_code=502, detail="Bad Gateway: Unable to reach the model provider.")
