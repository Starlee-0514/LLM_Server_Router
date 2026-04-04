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
from backend.app.database import get_db
from backend.app.models import ProviderEndpoint, ModelRoute, MeshWorker

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["openai"])

# 建立重複使用的非同步 HTTP Client
http_client = httpx.AsyncClient()


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


def _provider_headers(provider: ProviderEndpoint) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    if provider.extra_headers:
        try:
            parsed = json.loads(provider.extra_headers)
            if isinstance(parsed, dict):
                headers.update({str(k): str(v) for k, v in parsed.items()})
        except Exception:
            logger.warning("Provider extra_headers JSON parse failed: %s", provider.name)
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


async def _proxy_openai_compatible(target_url: str, headers: dict[str, str], body: dict):
    is_streaming = body.get("stream", False)
    if is_streaming:
        req = http_client.build_request("POST", target_url, headers=headers, json=body)

        async def generate():
            async with http_client.stream(req.method, req.url, headers=req.headers, content=req.content) as response:
                if response.status_code != 200:
                    err_text = await response.aread()
                    yield err_text
                    return
                async for chunk in response.aiter_bytes():
                    yield chunk

        return StreamingResponse(generate(), media_type="text/event-stream")

    response = await http_client.post(target_url, headers=headers, json=body, timeout=60.0)
    return JSONResponse(status_code=response.status_code, content=response.json())


@router.get("/models")
async def list_models(db: Session = Depends(get_db)):
    """Return aggregated model list from local processes and mesh workers."""
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
            
    workers = db.query(MeshWorker).all()
    for worker in workers:
        try:
            models = json.loads(worker.models_json or "[]")
        except Exception:
            models = []
        for model_name in models:
            data.append(
                {
                    "id": model_name,
                    "object": "model",
                    "created": 0,
                    "owned_by": f"mesh:{worker.node_name}",
                }
            )

    rules = db.query(ModelRoute).filter(ModelRoute.enabled == 1).all()
    for rule in rules:
        exposed_id = rule.target_model or rule.match_value
        data.append(
            {
                "id": exposed_id,
                "object": "model",
                "created": 0,
                "owned_by": "provider-route",
            }
        )

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

    # 1) Explicit model route table has highest priority.
    rule, provider = _find_model_route(db, model_name)
    if rule and provider:
        routed_model = rule.target_model or model_name
        if routed_model != model_name:
            body = {**body, "model": routed_model}

        if provider.provider_type == "local_process":
            port = llama_process_manager.get_router_port_for_model(routed_model)
            if port is None:
                raise HTTPException(status_code=503, detail=f"Local model '{routed_model}' is not currently running")
            request_stats.increment_local()
            target_url = f"http://127.0.0.1:{port}/v1/chat/completions"
            return await _proxy_openai_compatible(target_url, {"Content-Type": "application/json"}, body)

        if provider.provider_type == "openai_compatible":
            if not provider.base_url:
                raise HTTPException(status_code=500, detail=f"Provider '{provider.name}' base_url is empty")
            request_stats.increment_remote()
            target_url = provider.base_url.rstrip("/") + "/v1/chat/completions"
            return await _proxy_openai_compatible(target_url, _provider_headers(provider), body)

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
            anthropic_payload = {
                "model": routed_model,
                "messages": converted_messages,
                "max_tokens": int(body.get("max_tokens") or 1024),
                "temperature": body.get("temperature", 0.7),
            }
            if system_prompt:
                anthropic_payload["system"] = system_prompt

            request_stats.increment_remote()
            target_url = (provider.base_url.rstrip("/") if provider.base_url else "https://api.anthropic.com") + "/v1/messages"
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
                return JSONResponse(status_code=200, content=_convert_anthropic_to_openai(payload, routed_model))
            except httpx.RequestError as e:
                logger.error("連線至 Anthropic provider 失敗: %s", e)
                raise HTTPException(status_code=502, detail="Bad Gateway: Unable to reach Anthropic provider")

    # 2) Mesh worker auto-discovery by advertised model list.
    worker = _find_mesh_worker_for_model(db, model_name)
    if worker:
        headers = {"Content-Type": "application/json"}
        if worker.api_token:
            headers["Authorization"] = f"Bearer {worker.api_token}"
        request_stats.increment_remote()
        target_url = worker.base_url.rstrip("/") + "/v1/chat/completions"
        return await _proxy_openai_compatible(target_url, headers, body)

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
        anthropic_payload = {
            "model": model_name,
            "messages": converted_messages,
            "max_tokens": int(body.get("max_tokens") or 1024),
            "temperature": body.get("temperature", 0.7),
        }
        if system_prompt:
            anthropic_payload["system"] = system_prompt

        request_stats.increment_remote()
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
            return JSONResponse(status_code=200, content=_convert_anthropic_to_openai(payload, model_name))
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
        return await _proxy_openai_compatible(target_url, {"Content-Type": "application/json"}, body)
    except httpx.RequestError as e:
        logger.error(f"連線至目標 {target_url} 失敗: {e}")
        raise HTTPException(status_code=502, detail="Bad Gateway: Unable to reach the model provider.")
