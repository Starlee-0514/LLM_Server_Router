"""
Ollama-compatible REST API shim.

This exposes the router as an Ollama server so Ollama-native clients can use
the router without switching to an OpenAI configuration.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.app.core.process_manager import llama_process_manager
from backend.app.database import get_db
from backend.app.models import MeshWorker, ModelRoute, Setting, VirtualModel

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ollama-compat"])

OLLAMA_COMPAT_VERSION = "0.20.2"
_UNKNOWN_DIGEST = "sha256:" + "0" * 64
_DEFAULT_MODIFIED_AT = "1970-01-01T00:00:00Z"
_DEFAULT_EXPIRES_AT = "2999-12-31T23:59:59Z"
_PARAMETER_SIZE_PATTERN = re.compile(r"(?<!\d)(\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?[bm])(?!\w)", re.IGNORECASE)
_QUANTIZATION_PATTERN = re.compile(r"\b(i?q\d(?:_[0-9a-z]+)?|bf16|f16|f32)\b", re.IGNORECASE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _iso_or_default(value: Any, default: str = _DEFAULT_MODIFIED_AT) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    if isinstance(value, str) and value:
        return value
    return default


def _normalize_model_name(name: str) -> str:
    cleaned = (name or "").strip()
    return cleaned if not cleaned or ":" in cleaned else f"{cleaned}:latest"


def _candidate_model_names(name: str) -> list[str]:
    normalized = _normalize_model_name(name)
    base = normalized.split(":", 1)[0]
    candidates = [normalized, base]
    if not normalized.endswith(":latest"):
        candidates.append(f"{base}:latest")
    return list(dict.fromkeys([candidate for candidate in candidates if candidate]))


def _extract_parameter_size(name: str) -> str:
    match = _PARAMETER_SIZE_PATTERN.search(name or "")
    return match.group(1).upper() if match else "unknown"


def _extract_quantization(name: str) -> str:
    match = _QUANTIZATION_PATTERN.search(name or "")
    return match.group(1).upper() if match else "unknown"


def _infer_model_family(name: str) -> str:
    lowered = (name or "").lower()
    if "qwen" in lowered:
        return "qwen"
    if "gemma" in lowered:
        return "gemma"
    if "mistral" in lowered or "mixtral" in lowered:
        return "mistral"
    if "deepseek" in lowered:
        return "deepseek"
    if "phi" in lowered:
        return "phi"
    if "gpt-oss" in lowered:
        return "gpt_oss"
    if "llava" in lowered or "mllama" in lowered:
        return "llava"
    return "llama"


def _infer_model_details(name: str, model_path: str | None = None) -> dict[str, Any]:
    model_name = _normalize_model_name(name)
    family = _infer_model_family(model_name)
    model_format = "gguf" if (model_path or "").lower().endswith(".gguf") else "unknown"
    return {
        "parent_model": "",
        "format": model_format,
        "family": family,
        "families": [family],
        "parameter_size": _extract_parameter_size(model_name),
        "quantization_level": _extract_quantization(model_name),
    }


def _infer_capabilities(name: str) -> list[str]:
    lowered = (name or "").lower()
    capabilities = ["completion"]
    if any(marker in lowered for marker in ("vision", "vl", "llava", "mllama")):
        capabilities.append("vision")
    if any(marker in lowered for marker in ("thinking", "think", "reason", "r1")):
        capabilities.append("thinking")
    # Most modern LLMs support tool/function calling; exclude known non-tool models
    _no_tools = ("embed", "rerank", "tts", "whisper", "bert", "clip")
    if not any(marker in lowered for marker in _no_tools):
        capabilities.append("tools")
    return capabilities


def _safe_file_metadata(model_path: str | None) -> tuple[int, str]:
    if not model_path:
        return 0, _DEFAULT_MODIFIED_AT
    try:
        stat_result = os.stat(model_path)
    except OSError:
        return 0, _DEFAULT_MODIFIED_AT
    modified_at = datetime.fromtimestamp(stat_result.st_mtime, tz=timezone.utc)
    return int(stat_result.st_size), _iso_or_default(modified_at)


def _new_catalog_entry(name: str, *, source_name: str | None = None, model_path: str | None = None) -> dict[str, Any]:
    tag = _normalize_model_name(name)
    return {
        "name": tag,
        "model": tag,
        "source_name": source_name or name,
        "size": 0,
        "digest": _UNKNOWN_DIGEST,
        "modified_at": _DEFAULT_MODIFIED_AT,
        "details": _infer_model_details(source_name or name, model_path),
        "capabilities": _infer_capabilities(source_name or name),
        "loaded": False,
        "expires_at": _DEFAULT_EXPIRES_AT,
        "size_vram": 0,
        "context_length": 0,
        "remote_model": "",
        "remote_host": "",
    }


def _upsert_catalog_entry(
    catalog: dict[str, dict[str, Any]],
    name: str,
    *,
    source_name: str | None = None,
    model_path: str | None = None,
    size: int | None = None,
    modified_at: str | None = None,
    loaded: bool = False,
    expires_at: str | None = None,
    size_vram: int | None = None,
    context_length: int | None = None,
    remote_model: str | None = None,
    remote_host: str | None = None,
) -> None:
    tag = _normalize_model_name(name)
    entry = catalog.get(tag)
    if entry is None:
        entry = _new_catalog_entry(name, source_name=source_name, model_path=model_path)
        catalog[tag] = entry

    if source_name:
        entry["source_name"] = source_name
        entry["details"] = _infer_model_details(source_name, model_path)
        entry["capabilities"] = _infer_capabilities(source_name)
    if size not in (None, 0):
        entry["size"] = int(size)
    if modified_at:
        entry["modified_at"] = modified_at
    if loaded:
        entry["loaded"] = True
    if expires_at:
        entry["expires_at"] = expires_at
    if size_vram not in (None, 0):
        entry["size_vram"] = int(size_vram)
    if context_length not in (None, 0):
        entry["context_length"] = int(context_length)
    if remote_model:
        entry["remote_model"] = remote_model
    if remote_host:
        entry["remote_host"] = remote_host


async def _build_model_catalog(db: Session) -> dict[str, dict[str, Any]]:
    catalog: dict[str, dict[str, Any]] = {}

    for status in llama_process_manager.get_all_status():
        if not status.get("is_running"):
            continue
        size, modified_at = _safe_file_metadata(status.get("model_path"))
        _upsert_catalog_entry(
            catalog,
            status.get("identifier") or "",
            source_name=status.get("identifier") or "",
            model_path=status.get("model_path"),
            size=size,
            modified_at=modified_at,
            loaded=True,
            expires_at=_DEFAULT_EXPIRES_AT,
        )

    for rule in db.query(ModelRoute).filter(ModelRoute.enabled == 1).all():
        exposed = rule.route_name or rule.target_model or rule.match_value or ""
        if exposed:
            _upsert_catalog_entry(catalog, exposed, source_name=rule.target_model or rule.match_value or exposed)
            # Override capabilities from route config
            tag = _normalize_model_name(exposed)
            if tag in catalog:
                caps = catalog[tag]["capabilities"]
                if rule.supports_tools and "tools" not in caps:
                    caps.append("tools")
                if rule.supports_vision and "vision" not in caps:
                    caps.append("vision")
                if rule.supports_thinking and "thinking" not in caps:
                    caps.append("thinking")

    for worker in db.query(MeshWorker).filter(MeshWorker.status == "online").all():
        try:
            models = json.loads(worker.models_json or "[]")
        except Exception:
            models = []
        for model_name in models:
            if model_name:
                _upsert_catalog_entry(catalog, model_name, source_name=model_name)

    for virtual_model in db.query(VirtualModel).filter(VirtualModel.enabled == 1).all():
        if virtual_model.model_id:
            _upsert_catalog_entry(catalog, virtual_model.model_id, source_name=virtual_model.model_id)

    return catalog


def _resolve_catalog_entry(name: str, catalog: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    for candidate in _candidate_model_names(name):
        if candidate in catalog:
            return catalog[candidate]
    return None


def _model_to_ollama_tag(entry: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "name": entry["name"],
        "model": entry["model"],
        "modified_at": entry["modified_at"],
        "size": entry["size"],
        "digest": entry["digest"],
        "details": entry["details"],
    }
    if entry.get("remote_model"):
        payload["remote_model"] = entry["remote_model"]
    if entry.get("remote_host"):
        payload["remote_host"] = entry["remote_host"]
    return payload


def _model_to_ollama_process(entry: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "name": entry["name"],
        "model": entry["model"],
        "size": entry["size"],
        "digest": entry["digest"],
        "details": entry["details"],
        "expires_at": entry["expires_at"],
        "size_vram": entry["size_vram"],
        "context_length": entry["context_length"],
    }
    if entry.get("remote_model"):
        payload["remote_model"] = entry["remote_model"]
    if entry.get("remote_host"):
        payload["remote_host"] = entry["remote_host"]
    return payload


def _ollama_options_to_openai(options: dict[str, Any]) -> dict[str, Any]:
    field_map = {
        "temperature": "temperature",
        "top_p": "top_p",
        "num_predict": "max_tokens",
        "seed": "seed",
        "stop": "stop",
        "presence_penalty": "presence_penalty",
        "frequency_penalty": "frequency_penalty",
    }
    return {openai_key: options[ollama_key] for ollama_key, openai_key in field_map.items() if ollama_key in options}


def _ollama_format_to_openai(format_spec: Any) -> dict[str, Any] | None:
    if format_spec in (None, ""):
        return None
    if format_spec == "json":
        return {"type": "json_object"}

    schema: Any = format_spec
    if isinstance(format_spec, str):
        try:
            schema = json.loads(format_spec)
        except json.JSONDecodeError:
            return None

    if isinstance(schema, dict):
        return {
            "type": "json_schema",
            "json_schema": {
                "name": "ollama_schema",
                "schema": schema,
            },
        }
    return None


def _extract_text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                text_value = part.get("text") or part.get("input_text") or ""
                if isinstance(text_value, str):
                    chunks.append(text_value)
        return "".join(chunks)
    return ""


def _normalize_image_part(image: Any) -> dict[str, Any] | None:
    if image in (None, ""):
        return None
    value = image.decode("utf-8") if isinstance(image, bytes) else str(image)
    if not value:
        return None
    url = value if value.startswith("data:") else f"data:image/png;base64,{value}"
    return {"type": "image_url", "image_url": {"url": url}}


def _message_content_to_openai(content: Any, images: list[Any]) -> str | list[dict[str, Any]]:
    image_parts = [part for part in (_normalize_image_part(image) for image in images) if part]

    if isinstance(content, str) and not image_parts:
        return content

    parts: list[dict[str, Any]] = []
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict):
                parts.append(part)
    elif isinstance(content, str) and content:
        parts.append({"type": "text", "text": content})

    parts.extend(image_parts)
    return parts or ""


def _normalize_openai_tool_calls(tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for raw_tool in tool_calls:
        if not isinstance(raw_tool, dict):
            continue
        function = raw_tool.get("function") or {}
        arguments = function.get("arguments", {})
        normalized.append({
            "id": raw_tool.get("id", ""),
            "type": raw_tool.get("type", "function"),
            "function": {
                "name": function.get("name", ""),
                "arguments": arguments if isinstance(arguments, str) else json.dumps(arguments),
            },
        })
    return normalized


def _ollama_messages_to_openai(system: str | None, messages: list["OllamaMessage"]) -> list[dict[str, Any]]:
    openai_messages: list[dict[str, Any]] = []
    if system:
        openai_messages.append({"role": "system", "content": system})

    for message in messages:
        payload: dict[str, Any] = {
            "role": message.role,
            "content": _message_content_to_openai(message.content, message.images),
        }
        if message.tool_calls:
            payload["tool_calls"] = _normalize_openai_tool_calls(message.tool_calls)
        if message.tool_call_id:
            payload["tool_call_id"] = message.tool_call_id
        if message.tool_name:
            payload["name"] = message.tool_name
        openai_messages.append(payload)
    return openai_messages


def _append_fragment(current: str, fragment: str) -> str:
    if not fragment:
        return current
    if not current:
        return fragment
    if current.endswith(fragment):
        return current
    return current + fragment


def _normalize_logprobs(raw_logprobs: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_logprobs, dict):
        return []
    content = raw_logprobs.get("content") or []
    if not isinstance(content, list):
        return []

    normalized: list[dict[str, Any]] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        payload: dict[str, Any] = {
            "token": item.get("token", ""),
            "logprob": item.get("logprob", 0.0),
        }
        if item.get("bytes") is not None:
            payload["bytes"] = item.get("bytes")
        top_logprobs = item.get("top_logprobs") or []
        if isinstance(top_logprobs, list) and top_logprobs:
            payload["top_logprobs"] = [
                {
                    "token": candidate.get("token", ""),
                    "logprob": candidate.get("logprob", 0.0),
                    **({"bytes": candidate.get("bytes")} if candidate.get("bytes") is not None else {}),
                }
                for candidate in top_logprobs
                if isinstance(candidate, dict)
            ]
        normalized.append(payload)
    return normalized


def _parse_tool_arguments(arguments: str) -> Any:
    text = (arguments or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _parse_openai_sse(sse_bytes: bytes) -> dict[str, Any]:
    created_at = _now_iso()
    role = "assistant"
    content_parts: list[str] = []
    thinking_parts: list[str] = []
    tool_calls: dict[int, dict[str, Any]] = {}
    usage: dict[str, Any] = {}
    done_reason = "stop"
    logprobs: list[dict[str, Any]] = []

    for raw_line in sse_bytes.decode("utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line.startswith("data: "):
            continue
        payload = line[6:]
        if payload == "[DONE]":
            break

        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue

        if not isinstance(chunk, dict):
            continue

        chunk_created = chunk.get("created")
        if chunk_created is not None:
            try:
                created_at = datetime.fromtimestamp(float(chunk_created), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
            except (OSError, OverflowError, TypeError, ValueError):
                pass

        if chunk.get("usage"):
            usage.update(chunk["usage"])

        choices = chunk.get("choices") or []
        if not choices:
            continue

        choice = choices[0] if isinstance(choices[0], dict) else {}
        delta = choice.get("delta") or choice.get("message") or {}
        if not isinstance(delta, dict):
            delta = {}

        if isinstance(delta.get("role"), str):
            role = delta["role"]

        text_piece = _extract_text_from_content(delta.get("content"))
        if text_piece:
            content_parts.append(text_piece)

        for thinking_key in ("thinking", "reasoning", "reasoning_content"):
            thinking_piece = delta.get(thinking_key)
            if isinstance(thinking_piece, str) and thinking_piece:
                thinking_parts.append(thinking_piece)

        raw_tool_calls = delta.get("tool_calls") or []
        if isinstance(raw_tool_calls, list):
            for raw_tool in raw_tool_calls:
                if not isinstance(raw_tool, dict):
                    continue
                index = raw_tool.get("index", 0)
                try:
                    index = int(index)
                except (TypeError, ValueError):
                    index = 0
                tool_entry = tool_calls.setdefault(index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                tool_id = raw_tool.get("id")
                if isinstance(tool_id, str) and tool_id:
                    tool_entry["id"] = tool_id
                function = raw_tool.get("function") or {}
                if isinstance(function, dict):
                    name_fragment = function.get("name")
                    if isinstance(name_fragment, str):
                        tool_entry["function"]["name"] = _append_fragment(tool_entry["function"]["name"], name_fragment)
                    arguments_fragment = function.get("arguments")
                    if isinstance(arguments_fragment, str):
                        tool_entry["function"]["arguments"] = _append_fragment(tool_entry["function"]["arguments"], arguments_fragment)

        finish_reason = choice.get("finish_reason")
        if isinstance(finish_reason, str) and finish_reason:
            done_reason = finish_reason

        raw_choice_logprobs = choice.get("logprobs")
        if raw_choice_logprobs:
            logprobs = _normalize_logprobs(raw_choice_logprobs)

    finalized_tool_calls: list[dict[str, Any]] = []
    for index in sorted(tool_calls):
        tool_entry = tool_calls[index]
        function = tool_entry.get("function") or {}
        finalized_tool_calls.append({
            "id": tool_entry.get("id") or f"call_{index}",
            "function": {
                "name": function.get("name") or f"tool_{index}",
                "arguments": _parse_tool_arguments(function.get("arguments", "")),
            },
        })

    return {
        "created_at": created_at,
        "role": role,
        "content": "".join(content_parts),
        "content_parts": content_parts,
        "thinking": "".join(thinking_parts),
        "tool_calls": finalized_tool_calls,
        "usage": usage,
        "done_reason": done_reason,
        "logprobs": logprobs,
    }


def _build_chat_message(parsed: dict[str, Any], content: str) -> dict[str, Any]:
    message: dict[str, Any] = {
        "role": parsed["role"],
        "content": content,
    }
    if parsed["thinking"]:
        message["thinking"] = parsed["thinking"]
    if parsed["tool_calls"]:
        message["tool_calls"] = parsed["tool_calls"]
    return message


def _build_chat_stream_lines(model: str, parsed: dict[str, Any]) -> list[bytes]:
    lines: list[bytes] = []
    for content_part in parsed["content_parts"]:
        lines.append(
            json.dumps({
                "model": model,
                "created_at": parsed["created_at"],
                "message": {"role": parsed["role"], "content": content_part},
                "done": False,
            }).encode() + b"\n"
        )

    final_payload: dict[str, Any] = {
        "model": model,
        "created_at": parsed["created_at"],
        "message": _build_chat_message(parsed, ""),
        "done": True,
        "done_reason": parsed["done_reason"],
        "prompt_eval_count": parsed["usage"].get("prompt_tokens", 0),
        "eval_count": parsed["usage"].get("completion_tokens", 0),
    }
    if parsed["logprobs"]:
        final_payload["logprobs"] = parsed["logprobs"]
    lines.append(json.dumps(final_payload).encode() + b"\n")
    return lines


def _build_generate_stream_lines(model: str, parsed: dict[str, Any]) -> list[bytes]:
    lines: list[bytes] = []
    for content_part in parsed["content_parts"]:
        lines.append(
            json.dumps({
                "model": model,
                "created_at": parsed["created_at"],
                "response": content_part,
                "done": False,
            }).encode() + b"\n"
        )

    final_payload: dict[str, Any] = {
        "model": model,
        "created_at": parsed["created_at"],
        "response": "",
        "done": True,
        "done_reason": parsed["done_reason"],
        "prompt_eval_count": parsed["usage"].get("prompt_tokens", 0),
        "eval_count": parsed["usage"].get("completion_tokens", 0),
    }
    if parsed["thinking"]:
        final_payload["thinking"] = parsed["thinking"]
    if parsed["tool_calls"]:
        final_payload["tool_calls"] = parsed["tool_calls"]
    if parsed["logprobs"]:
        final_payload["logprobs"] = parsed["logprobs"]
    lines.append(json.dumps(final_payload).encode() + b"\n")
    return lines


def _build_chat_response(model: str, parsed: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "created_at": parsed["created_at"],
        "message": _build_chat_message(parsed, parsed["content"]),
        "done": True,
        "done_reason": parsed["done_reason"],
        "prompt_eval_count": parsed["usage"].get("prompt_tokens", 0),
        "eval_count": parsed["usage"].get("completion_tokens", 0),
    }
    if parsed["logprobs"]:
        payload["logprobs"] = parsed["logprobs"]
    return payload


def _build_generate_response(model: str, parsed: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "created_at": parsed["created_at"],
        "response": parsed["content"],
        "done": True,
        "done_reason": parsed["done_reason"],
        "prompt_eval_count": parsed["usage"].get("prompt_tokens", 0),
        "eval_count": parsed["usage"].get("completion_tokens", 0),
    }
    if parsed["thinking"]:
        payload["thinking"] = parsed["thinking"]
    if parsed["tool_calls"]:
        payload["tool_calls"] = parsed["tool_calls"]
    if parsed["logprobs"]:
        payload["logprobs"] = parsed["logprobs"]
    return payload


def _normalize_ollama_error(payload: bytes) -> dict[str, Any]:
    try:
        decoded = json.loads(payload)
    except Exception:
        return {"error": payload.decode(errors="replace")[:1000]}

    if isinstance(decoded, dict):
        error = decoded.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("error") or json.dumps(error)
            return {"error": message}
        if isinstance(error, str):
            return {"error": error}
        detail = decoded.get("detail")
        if isinstance(detail, dict):
            return {"error": detail.get("message") or detail.get("error") or json.dumps(detail)}
        if isinstance(detail, str):
            return {"error": detail}
        return decoded
    return {"error": str(decoded)}


def _get_api_token(db: Session) -> str:
    row = db.query(Setting).filter(Setting.key == "api_token").first()
    return (row.value or "").strip() if row else ""


async def _call_openai_compat(openai_body: dict[str, Any], api_token: str) -> tuple[int, bytes]:
    from backend.app.main import app as _app  # noqa: PLC0415

    headers: dict[str, str] = {"content-type": "application/json"}
    if api_token:
        headers["authorization"] = f"Bearer {api_token}"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app),
        base_url="http://testserver",
        timeout=httpx.Timeout(connect=15.0, read=300.0, write=30.0, pool=5.0),
    ) as client:
        response = await client.post("/v1/chat/completions", json=openai_body, headers=headers)
        return response.status_code, response.content


async def _yield_lines(lines: list[bytes]) -> AsyncIterator[bytes]:
    for line in lines:
        yield line


class OllamaMessage(BaseModel):
    role: str
    content: str | list[dict[str, Any]] = ""
    thinking: str | None = None
    images: list[Any] = Field(default_factory=list)
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    tool_name: str | None = None
    tool_call_id: str | None = None


class OllamaChatRequest(BaseModel):
    model: str = ""
    messages: list[OllamaMessage] = Field(default_factory=list)
    stream: bool = True
    system: str | None = None
    options: dict[str, Any] = Field(default_factory=dict)
    format: Any | None = None
    keep_alive: Any | None = None
    tools: list[dict[str, Any]] = Field(default_factory=list)
    think: bool | str | None = None
    truncate: bool | None = None
    shift: bool | None = None
    logprobs: bool = False
    top_logprobs: int | None = None


class OllamaGenerateRequest(BaseModel):
    model: str = ""
    prompt: str = ""
    suffix: str = ""
    stream: bool = True
    system: str | None = None
    template: str | None = None
    raw: bool = False
    options: dict[str, Any] = Field(default_factory=dict)
    format: Any | None = None
    context: list[int] | None = None
    keep_alive: Any | None = None
    images: list[Any] = Field(default_factory=list)
    think: bool | str | None = None
    truncate: bool | None = None
    shift: bool | None = None
    logprobs: bool = False
    top_logprobs: int | None = None


class OllamaShowRequest(BaseModel):
    model: str = ""
    system: str = ""
    template: str = ""
    verbose: bool = False
    options: dict[str, Any] = Field(default_factory=dict)
    name: str | None = None


@router.api_route("/", methods=["GET", "HEAD"], response_class=PlainTextResponse)
async def ollama_root() -> str:
    return "Ollama is running"


@router.api_route("/api/version", methods=["GET", "HEAD"])
async def ollama_version() -> dict[str, str]:
    return {"version": OLLAMA_COMPAT_VERSION}


@router.api_route("/api/tags", methods=["GET", "HEAD"])
async def ollama_tags(db: Session = Depends(get_db)) -> dict[str, list[dict[str, Any]]]:
    catalog = await _build_model_catalog(db)
    models = sorted(catalog.values(), key=lambda item: item["modified_at"], reverse=True)
    return {"models": [_model_to_ollama_tag(model) for model in models]}


@router.get("/api/ps")
async def ollama_ps(db: Session = Depends(get_db)) -> dict[str, list[dict[str, Any]]]:
    catalog = await _build_model_catalog(db)
    loaded_models = [entry for entry in catalog.values() if entry.get("loaded")]
    return {"models": [_model_to_ollama_process(model) for model in loaded_models]}


@router.post("/api/show")
async def ollama_show(req: OllamaShowRequest, db: Session = Depends(get_db)):
    requested_name = (req.model or req.name or "").strip()
    if not requested_name:
        return JSONResponse(status_code=400, content={"error": "model is required"})

    catalog = await _build_model_catalog(db)
    entry = _resolve_catalog_entry(requested_name, catalog)
    if entry is None:
        return JSONResponse(status_code=404, content={"error": f"model '{requested_name}' not found"})

    context_length = entry.get("context_length") or 4096
    parameters = f"num_ctx {context_length}"
    response: dict[str, Any] = {
        "license": "",
        "modelfile": f"FROM {entry['name']}\nPARAMETER num_ctx {context_length}",
        "parameters": parameters,
        "template": req.template or "{{ .Prompt }}",
        "system": req.system,
        "details": entry["details"],
        "messages": [],
        "model_info": {"general.basename": entry["name"].split(":", 1)[0]},
        "capabilities": entry["capabilities"],
        "modified_at": entry["modified_at"],
    }
    if entry.get("remote_model"):
        response["remote_model"] = entry["remote_model"]
    if entry.get("remote_host"):
        response["remote_host"] = entry["remote_host"]
    return JSONResponse(response)


@router.post("/api/chat")
async def ollama_chat(req: OllamaChatRequest, db: Session = Depends(get_db)):
    requested_model = req.model.strip()
    if not requested_model:
        return JSONResponse(status_code=400, content={"error": "model is required"})
    if not req.messages:
        return JSONResponse(status_code=400, content={"error": "messages are required"})

    # Strip Ollama ':latest' tag — providers/routes use bare model names
    routed_model = requested_model.removesuffix(":latest")

    openai_body: dict[str, Any] = {
        "model": routed_model,
        "messages": _ollama_messages_to_openai(req.system, req.messages),
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    openai_body.update(_ollama_options_to_openai(req.options))

    response_format = _ollama_format_to_openai(req.format)
    if response_format:
        openai_body["response_format"] = response_format
    if req.tools:
        openai_body["tools"] = req.tools
    if req.logprobs:
        openai_body["logprobs"] = True
    if req.top_logprobs is not None:
        openai_body["top_logprobs"] = req.top_logprobs
    if isinstance(req.think, str) and req.think in {"low", "medium", "high"}:
        openai_body["reasoning_effort"] = req.think

    status_code, body_bytes = await _call_openai_compat(openai_body, _get_api_token(db))
    if status_code != 200:
        return JSONResponse(status_code=status_code, content=_normalize_ollama_error(body_bytes))

    parsed = _parse_openai_sse(body_bytes)
    if not req.stream:
        return JSONResponse(_build_chat_response(requested_model, parsed))

    return StreamingResponse(_yield_lines(_build_chat_stream_lines(requested_model, parsed)), media_type="application/x-ndjson")


@router.post("/api/generate")
async def ollama_generate(req: OllamaGenerateRequest, db: Session = Depends(get_db)):
    requested_model = req.model.strip()
    if not requested_model:
        return JSONResponse(status_code=400, content={"error": "model is required"})

    # Strip Ollama ':latest' tag — providers/routes use bare model names
    routed_model = requested_model.removesuffix(":latest")

    prompt_content = _message_content_to_openai(req.prompt, req.images)
    messages: list[dict[str, Any]] = []
    if req.system:
        messages.append({"role": "system", "content": req.system})
    messages.append({"role": "user", "content": prompt_content})

    openai_body: dict[str, Any] = {
        "model": routed_model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    openai_body.update(_ollama_options_to_openai(req.options))

    response_format = _ollama_format_to_openai(req.format)
    if response_format:
        openai_body["response_format"] = response_format
    if req.logprobs:
        openai_body["logprobs"] = True
    if req.top_logprobs is not None:
        openai_body["top_logprobs"] = req.top_logprobs
    if isinstance(req.think, str) and req.think in {"low", "medium", "high"}:
        openai_body["reasoning_effort"] = req.think

    status_code, body_bytes = await _call_openai_compat(openai_body, _get_api_token(db))
    if status_code != 200:
        return JSONResponse(status_code=status_code, content=_normalize_ollama_error(body_bytes))

    parsed = _parse_openai_sse(body_bytes)
    if not req.stream:
        return JSONResponse(_build_generate_response(requested_model, parsed))

    return StreamingResponse(_yield_lines(_build_generate_stream_lines(requested_model, parsed)), media_type="application/x-ndjson")
