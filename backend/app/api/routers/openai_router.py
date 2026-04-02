"""
API 端點：OpenAI 兼容路由 (Proxy)

處理 /v1/chat/completions 與 /v1/models 的轉發。
負責判斷要把流量打給本機的 llama-server 還是遠端的 Anthropic/OpenAI API。
"""
import json
import logging

import httpx
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse

from backend.app.core.config import settings
from backend.app.core.process_manager import llama_process_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["openai"])

# 建立重複使用的非同步 HTTP Client
http_client = httpx.AsyncClient()


@router.get("/models")
async def list_models():
    """回傳目前可用模型的清單相容格式。
    
    包含正在運行的本地模型。遠端模型因為無窮無盡，暫不列舉，
    但客戶端仍可以直接發送給遠端模型。
    """
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
            
    # 預設總是假裝我們也提供 gpt-4o 等，如果 UI 需要的話
    data.append({
        "id": "gpt-4o",
        "object": "model",
        "created": 0,
        "owned_by": "openai",
    })
    
    return {"object": "list", "data": data}


@router.post("/chat/completions")
async def chat_completions(request: Request):
    """處理對話請求，進行透明反向代理。"""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
        
    model_name = body.get("model", "")
    if not model_name:
        raise HTTPException(status_code=400, detail="Missing 'model' in request body")

    is_remote_openai = model_name.startswith("gpt-") or model_name.startswith("o1-")
    is_remote_anthropic = model_name.startswith("claude-")

    # 1. 決定目標 URL 與 Headers
    if is_remote_openai:
        if not settings.openai_api_key:
            raise HTTPException(status_code=500, detail="OpenAI API Key 未設定")
        target_url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json"
        }
        
    elif is_remote_anthropic:
        # 注意：雖然是收 /v1/chat/completions 格式，但如果直接轉發給 Anthropic，
        # Anthropic 的 Messages API 格式與 OpenAI 不完全相容。
        # 實務上這裡可能需要做格式轉換，或使用類似 litellm 的套件。
        # 此處先保留轉發邏輯，如果客戶端使用的是支援 Anthropic native URL的，這裡可能要有特例。
        # 為了簡化，如果是 claude 模型，我們直接丟給 openai 相容的 endpoint (例如某些中轉站)，
        # 或是如果沒有轉換，先拋錯提醒。
        raise HTTPException(
            status_code=501, 
            detail="目前尚不支援直接原生地將 OpenAI 格式自動轉換成 Anthropic 格式。請實作轉換層。"
        )
        
    else:
        # 判定為本地模型
        port = llama_process_manager.get_router_port_for_model(model_name)
        
        if port is None:
            # 本地未啟動該模型
            logger.warning(f"請求本地模型 {model_name} 但尚未啟動。回傳 503。")
            raise HTTPException(
                status_code=503, 
                detail=f"Local model '{model_name}' is not currently running. 系統設定不會自動啟動，請手動啟動。"
            )
            
        target_url = f"http://127.0.0.1:{port}/v1/chat/completions"
        headers = {"Content-Type": "application/json"} # 本地不需要 Auth

    # 確認是否要求 streaming
    is_streaming = body.get("stream", False)

    logger.info(f"Routing request for model '{model_name}' to {target_url} (stream: {is_streaming})")

    try:
        if is_streaming:
            # 建立 Streaming 回應
            req = http_client.build_request("POST", target_url, headers=headers, json=body)
            async def generate():
                async with http_client.stream(req.method, req.url, headers=req.headers, content=req.content) as response:
                    if response.status_code != 200:
                        # 如果出錯，回傳錯誤訊息
                        err_text = await response.aread()
                        yield err_text
                        return
                    async for chunk in response.aiter_bytes():
                        yield chunk

            return StreamingResponse(generate(), media_type="text/event-stream")
        else:
            # 非 Streaming 回應
            response = await http_client.post(target_url, headers=headers, json=body, timeout=60.0)
            return JSONResponse(status_code=response.status_code, content=response.json())
            
    except httpx.RequestError as e:
        logger.error(f"連線至目標 {target_url} 失敗: {e}")
        raise HTTPException(status_code=502, detail="Bad Gateway: Unable to reach the model provider.")
