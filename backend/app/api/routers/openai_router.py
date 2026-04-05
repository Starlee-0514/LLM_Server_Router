"""OpenAI-compatible routing for local, provider, and mesh backends."""
import json
import logging
import time

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
            prompt_preview = (m.get("content") or "")[:120]
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
}


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


def _is_lmstudio_provider(provider: ProviderEndpoint) -> bool:
    """Return True if this provider points to a local or network LM Studio server."""
    base = (provider.base_url or "").lower().rstrip("/")
    name = (provider.name or "").lower()
    # Port 1234 is LM Studio's default; accept both localhost and any IP/hostname
    if ":1234" in base:
        return True
    if name in {"lm_studio", "lm studio", "lmstudio", "lm-studio"}:
        return True
    return False


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
    """Proxy an OpenAI-format request through Cloud Code Assist (native Gemini API)."""
    t0 = time.time()
    model_name = body.get("model", "")
    messages = body.get("messages", [])
    max_tokens = body.get("max_tokens") or body.get("max_completion_tokens") or 8192
    temperature = body.get("temperature")

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
        "requestId": f"router-{int(time.time())}-{model_name}",
    }
    if project_id:
        gemini_body["project"] = project_id

    target_url = "https://cloudcode-pa.googleapis.com/v1internal:generateContent"
    req_headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        **_GEMINI_CLI_HEADERS,
    }

    # Retry with exponential backoff on 429 (quota limit)
    import asyncio
    max_retries = 3
    for attempt in range(max_retries + 1):
        try:
            response = await http_client.post(target_url, headers=req_headers, json=gemini_body, timeout=120.0)
        except httpx.RequestError as e:
            logger.error("Gemini Cloud Code request error: %s", e)
            return JSONResponse(status_code=502, content={"error": {"message": f"Failed to reach Gemini Cloud Code: {e}"}})

        if response.status_code == 429 and attempt < max_retries:
            wait = 2 ** attempt * 2  # 2s, 4s, 8s
            logger.warning("Gemini rate limited (429), retrying in %ds (attempt %d/%d)", wait, attempt + 1, max_retries)
            await asyncio.sleep(wait)
            continue

        if response.status_code != 200:
            logger.warning("Gemini Cloud Code error %s: %s", response.status_code, response.text[:500])
            try:
                err = response.json()
            except Exception:
                err = {"error": {"message": response.text[:1000]}}
            return JSONResponse(status_code=response.status_code, content=err)

        break

    gemini_resp = response.json()
    openai_resp = _convert_gemini_to_openai(gemini_resp, model_name)
    elapsed = time.time() - t0
    _log_completion_usage(body, openai_resp, target_url, db=db, elapsed=elapsed)
    return JSONResponse(status_code=200, content=openai_resp)


def _provider_headers(provider: ProviderEndpoint) -> dict[str, str]:
    headers = build_provider_headers(provider.api_key or "", provider.extra_headers or "")
    return headers


async def _build_oauth_provider_headers(provider: ProviderEndpoint, db: Session) -> dict[str, str]:
    """Build headers for OAuth providers (e.g. Google Gemini) with auto-refresh."""
    api_key = provider.api_key or ""
    headers = {"Content-Type": "application/json"}

    try:
        token_data = json.loads(api_key)
    except (json.JSONDecodeError, TypeError):
        headers["Authorization"] = f"Bearer {api_key}"
        return headers

    access_token = token_data.get("access_token", "")
    refresh_token = token_data.get("refresh_token", "")

    # Try to refresh if we have a refresh_token (Google OAuth tokens expire in ~1 hour)
    if refresh_token:
        try:
            from backend.app.core.runtime_settings import get_google_client_id, get_google_client_secret
            from backend.app.api.routers.provider_routes import _get_google_creds
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
                if new_access:
                    access_token = new_access
                    token_data["access_token"] = new_access
                    if payload.get("refresh_token"):
                        token_data["refresh_token"] = payload["refresh_token"]
                    provider.api_key = json.dumps(token_data)
                    db.commit()
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
    rules = (
        db.query(ModelRoute)
        .filter(ModelRoute.enabled == 1)
        .order_by(ModelRoute.priority.asc(), ModelRoute.created_at.asc())
        .all()
    )
    for rule in rules:
        matched = False
        if rule.match_type == "exact" and model_name == rule.match_value:
            matched = True
        elif rule.match_type == "prefix" and model_name.startswith(rule.match_value):
            matched = True
        if not matched:
            continue

        provider = (
            db.query(ProviderEndpoint)
            .filter(ProviderEndpoint.id == rule.provider_id, ProviderEndpoint.enabled == 1)
            .first()
        )
        if provider:
            return rule, provider

    return None, None


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
    )

    providers = (
        db.query(ProviderEndpoint)
        .filter(ProviderEndpoint.enabled == 1)
        .all()
    )
    for prov in providers:
        base_url = (prov.base_url or "").rstrip("/").lower()
        prov_name = (prov.name or "").strip().lower()

        catalog: list[dict[str, str]] = []
        # Check by name first (more specific), then by base_url
        if prov_name in {"github_models", "github-models"}:
            catalog = GITHUB_MODELS_DEFAULT_MODELS
        elif prov_name in {"github_copilot", "github-copilot"} or "githubcopilot.com" in base_url:
            catalog = GITHUB_COPILOT_DEFAULT_MODELS + GITHUB_MODELS_DEFAULT_MODELS
        elif "cloudcode-pa.googleapis.com" in base_url or prov_name in {"google_gemini_cli", "google-gemini-cli", "gemini-cli"}:
            catalog = GEMINI_CLI_DEFAULT_MODELS
        elif "generativelanguage.googleapis.com" in base_url or prov_name in {"google_gemini_openai"}:
            catalog = GEMINI_CLI_DEFAULT_MODELS

        for item in catalog:
            if item["id"] == model_name:
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
):
    is_streaming = body.get("stream", False)
    t0 = time.time()
    if is_streaming:
        req = http_client.build_request("POST", target_url, headers=headers, json=body)
        # 串流超時：連線 15s，每個 chunk 之間最多等 120s
        response = await http_client.send(
            req, stream=True,
            timeout=httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=5.0),
        )

        if response.status_code != 200:
            err_body = await response.aread()
            await response.aclose()
            logger.warning("Upstream error %s from %s: %s", response.status_code, target_url, err_body[:500])
            try:
                err_json = json.loads(err_body)
            except Exception:
                err_json = {"error": {"message": err_body.decode(errors="replace")[:1000]}}
            return JSONResponse(status_code=response.status_code, content=err_json)

        async def generate():
            try:
                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                await response.aclose()

        return StreamingResponse(generate(), media_type="text/event-stream")

    response = await http_client.post(target_url, headers=headers, json=body, timeout=120.0)
    elapsed = time.time() - t0
    if response.status_code != 200:
        logger.warning("Upstream error %s from %s: %s", response.status_code, target_url, response.text[:500])
    else:
        _log_completion_usage(
            body, response.json(), target_url, db=db, elapsed=elapsed,
            model_resolved=model_resolved, provider_name=provider_name,
            provider_type=provider_type, conversation_id=conversation_id,
            tool_calls_count=tool_calls_count,
        )
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
        exposed_id = rule.target_model or rule.match_value
        data.append({
            "id": exposed_id,
            "object": "model",
            "created": 0,
            "owned_by": "provider-route",
        })

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
    rule, provider = _find_model_route(db, model_name)
    if rule and provider:
        routed_model = rule.target_model or model_name
        # For prefix routes with no explicit target_model, strip the matched
        # prefix so "github-copilot/gpt-5-mini" → "gpt-5-mini" upstream.
        if not rule.target_model and rule.match_type == "prefix" and model_name.startswith(rule.match_value):
            routed_model = model_name[len(rule.match_value):]
        if routed_model != model_name:
            body = {**body, "model": routed_model}

        if policy == POLICY_REMOTE_ONLY and provider.provider_type == "local_process":
            # Skip local process if policy says remote only
            pass
        elif provider.provider_type == "local_process":
            port = llama_process_manager.get_router_port_for_model(routed_model)
            if port is None:
                raise HTTPException(status_code=503, detail=f"Local model '{routed_model}' is not currently running")
            request_stats.increment_local()
            target_url = f"http://127.0.0.1:{port}/v1/chat/completions"
            return await _proxy_openai_compatible(
                target_url, {"Content-Type": "application/json"}, body, db=db,
                model_resolved=routed_model, provider_name="local", provider_type="local_process",
                conversation_id=conversation_id,
            )

        if provider.provider_type == "openai_compatible":
            if not provider.base_url:
                raise HTTPException(status_code=500, detail=f"Provider '{provider.name}' base_url is empty")
            request_stats.increment_remote()

            # Translate tools for the provider if needed
            fwd_body = translate_tools(body, provider.provider_type)

            # Gemini Cloud Code: use native API translation
            if _is_gemini_cloudcode_provider(provider):
                return await _proxy_gemini_cloudcode(provider, db, body)

            target_url = build_provider_chat_url(provider.base_url)

            # GitHub Copilot: auto-refresh token and add Copilot-specific headers
            if _is_copilot_provider(provider):
                copilot_token = await _ensure_fresh_copilot_token(provider, db)
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {copilot_token}",
                    **COPILOT_STATIC_HEADERS,
                }
                return await _proxy_openai_compatible(
                    target_url, headers, fwd_body, db=db,
                    model_resolved=routed_model, provider_name=provider.name,
                    provider_type=provider.provider_type, conversation_id=conversation_id,
                )

            # GitHub Models: uses same Copilot token exchange + Copilot headers
            if _is_github_models_provider(provider):
                gh_token = await _ensure_fresh_github_models_token(provider, db)
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {gh_token}",
                    **COPILOT_STATIC_HEADERS,
                }
                return await _proxy_openai_compatible(
                    target_url, headers, fwd_body, db=db,
                    model_resolved=routed_model, provider_name=provider.name,
                    provider_type=provider.provider_type, conversation_id=conversation_id,
                )

            # Google OAuth: extract access_token from JSON-encoded api_key and auto-refresh
            if (provider.api_key or "").startswith("{"):
                headers = await _build_oauth_provider_headers(provider, db)
                return await _proxy_openai_compatible(
                    target_url, headers, fwd_body, db=db,
                    model_resolved=routed_model, provider_name=provider.name,
                    provider_type=provider.provider_type, conversation_id=conversation_id,
                )

            return await _proxy_openai_compatible(
                target_url, _provider_headers(provider), fwd_body, db=db,
                model_resolved=routed_model, provider_name=provider.name,
                provider_type=provider.provider_type, conversation_id=conversation_id,
            )

        if provider.provider_type == "anthropic":
            if body.get("stream", False):
                raise HTTPException(status_code=501, detail="Anthropic streaming conversion is not implemented yet")
            messages = body.get("messages")
            if not isinstance(messages, list):
                raise HTTPException(status_code=400, detail="Invalid or missing 'messages'")

            api_key = provider.api_key or get_anthropic_api_key()
            if not api_key:
                raise HTTPException(status_code=500, detail=f"Anthropic API key for provider '{provider.name}' is missing")

            system_prompt, converted_messages = _convert_openai_messages_to_anthropic(messages)

            # Translate OpenAI tools → Anthropic tool_use format
            openai_tools = body.get("tools")
            anthropic_tools = translate_tools_for_anthropic(openai_tools) if openai_tools else None

            anthropic_payload = {
                "model": routed_model,
                "messages": converted_messages,
                "max_tokens": int(body.get("max_tokens") or 1024),
                "temperature": body.get("temperature", 0.7),
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
                    return JSONResponse(status_code=response.status_code, content=payload)
                openai_resp = _convert_anthropic_to_openai(payload, routed_model)
                _log_completion_usage(
                    body, openai_resp, target_url, db=db,
                    elapsed=time.time() - t0_ant,
                    model_resolved=routed_model, provider_name=provider.name,
                    provider_type="anthropic", conversation_id=conversation_id,
                    tool_calls_count=len(openai_tools) if openai_tools else 0,
                )
                return JSONResponse(status_code=200, content=openai_resp)
            except httpx.RequestError as e:
                logger.error("連線至 Anthropic provider 失敗: %s", e)
                raise HTTPException(status_code=502, detail="Bad Gateway: Unable to reach Anthropic provider")

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
