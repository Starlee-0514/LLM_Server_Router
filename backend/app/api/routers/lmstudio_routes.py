"""
LM Studio management API

Endpoints:
  GET  /api/lmstudio/status                 - Probe server + list loaded models
  POST /api/lmstudio/server/start           - Start lms server
  POST /api/lmstudio/server/stop            - Stop lms server
  POST /api/lmstudio/models/load            - Load a model (lms load)
  POST /api/lmstudio/models/unload          - Unload model(s) (lms unload)
  GET  /api/lmstudio/cli                    - Check whether lms CLI is installed
  POST /api/lmstudio/provider/register      - Register LM Studio as a ProviderEndpoint
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import ProviderEndpoint
from backend.app.services import lmstudio_service as lms

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/lmstudio", tags=["lmstudio"])


# ---------------------------------------------------------------------------
# Request/response schemas
# ---------------------------------------------------------------------------

class LMStudioStatusResponse(BaseModel):
    running: bool
    port: int
    host: str
    loaded_models: list[str]
    available_models: list[str]
    error: str = ""


class ServerStartRequest(BaseModel):
    port: int = lms.DEFAULT_PORT
    bind: str | None = None    # e.g. "0.0.0.0" to expose on LAN


class ModelLoadRequest(BaseModel):
    identifier: str             # e.g. "lmstudio-community/Qwen2.5-7B-Instruct-GGUF"
    gpu: float | None = None    # 0.0 → CPU only, 1.0 → max GPU, None → auto
    ctx_length: int | None = None


class ModelUnloadRequest(BaseModel):
    identifier: str | None = None
    unload_all: bool = False


class ProviderRegisterRequest(BaseModel):
    host: str = lms.DEFAULT_HOST
    port: int = lms.DEFAULT_PORT
    name: str = "LM Studio"
    enabled: bool = True


class CommandResponse(BaseModel):
    success: bool
    message: str
    stdout: str = ""
    stderr: str = ""


class CliCheckResponse(BaseModel):
    available: bool
    message: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/cli", response_model=CliCheckResponse)
def check_cli():
    """Return whether the `lms` CLI binary is installed."""
    available = lms.lms_available()
    return CliCheckResponse(
        available=available,
        message="lms CLI found" if available else (
            "lms CLI not found. Install with: npm install -g @lmstudio/lms"
        ),
    )


@router.get("/status", response_model=LMStudioStatusResponse)
async def get_status(host: str = lms.DEFAULT_HOST, port: int = lms.DEFAULT_PORT):
    """Probe the LM Studio HTTP server and return its status."""
    status = await lms.get_status(host=host, port=port)
    return LMStudioStatusResponse(
        running=status.running,
        port=status.port,
        host=status.host,
        loaded_models=status.loaded_models,
        available_models=status.available_models,
        error=status.error,
    )


@router.post("/server/start", response_model=CommandResponse)
async def start_server(req: ServerStartRequest):
    """Start the LM Studio HTTP server via `lms server start`."""
    if not lms.lms_available():
        raise HTTPException(status_code=503, detail="lms CLI not installed")
    result = await lms.server_start(port=req.port, bind=req.bind)
    return CommandResponse(**vars(result))


@router.post("/server/stop", response_model=CommandResponse)
async def stop_server():
    """Stop the LM Studio HTTP server via `lms server stop`."""
    if not lms.lms_available():
        raise HTTPException(status_code=503, detail="lms CLI not installed")
    result = await lms.server_stop()
    return CommandResponse(**vars(result))


@router.post("/models/load", response_model=CommandResponse)
async def load_model(req: ModelLoadRequest):
    """Load a model into LM Studio via `lms load`."""
    if not lms.lms_available():
        raise HTTPException(status_code=503, detail="lms CLI not installed")
    if not req.identifier.strip():
        raise HTTPException(status_code=422, detail="identifier is required")
    result = await lms.model_load(req.identifier.strip(), gpu=req.gpu, ctx_length=req.ctx_length)
    return CommandResponse(**vars(result))


@router.post("/models/unload", response_model=CommandResponse)
async def unload_model(req: ModelUnloadRequest):
    """Unload model(s) via `lms unload`."""
    if not lms.lms_available():
        raise HTTPException(status_code=503, detail="lms CLI not installed")
    if not req.identifier and not req.unload_all:
        raise HTTPException(status_code=422, detail="Provide an identifier or set unload_all=true")
    result = await lms.model_unload(identifier=req.identifier, unload_all=req.unload_all)
    return CommandResponse(**vars(result))


@router.post("/provider/register", response_model=dict)
def register_provider(req: ProviderRegisterRequest, db: Session = Depends(get_db)):
    """Register the running LM Studio server as a ProviderEndpoint in the router DB."""
    base_url = f"http://{req.host}:{req.port}"

    existing = db.query(ProviderEndpoint).filter(ProviderEndpoint.name == req.name).first()
    if existing:
        existing.base_url = base_url
        existing.provider_type = "openai_compatible"
        existing.api_key = ""
        existing.extra_headers = ""
        existing.enabled = 1 if req.enabled else 0
        db.commit()
        db.refresh(existing)
        return {"id": existing.id, "name": existing.name, "base_url": existing.base_url, "created": False}

    row = ProviderEndpoint(
        name=req.name,
        provider_type="openai_compatible",
        base_url=base_url,
        api_key="",
        extra_headers="",
        enabled=1 if req.enabled else 0,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    logger.info("Registered LM Studio provider: %s @ %s", req.name, base_url)
    return {"id": row.id, "name": row.name, "base_url": row.base_url, "created": True}
