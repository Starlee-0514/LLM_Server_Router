"""
Ollama management API

Endpoints:
  GET  /api/ollama/status                   - Probe server + list models
  POST /api/ollama/models/pull              - Pull a model
  POST /api/ollama/models/delete            - Delete a model
  POST /api/ollama/provider/register        - Register Ollama as a ProviderEndpoint
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import ProviderEndpoint
from backend.app.services import ollama_service as ols

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ollama", tags=["ollama"])


# ---------------------------------------------------------------------------
# Request/response schemas
# ---------------------------------------------------------------------------

class OllamaModelInfo(BaseModel):
    name: str
    size: int = 0
    digest: str = ""
    parameter_size: str = ""
    quantization_level: str = ""


class OllamaRunningModelInfo(BaseModel):
    name: str
    size: int = 0
    vram_size: int = 0
    expires_at: str = ""


class OllamaStatusResponse(BaseModel):
    running: bool
    port: int
    host: str
    local_models: list[OllamaModelInfo]
    running_models: list[OllamaRunningModelInfo]
    error: str = ""


class ModelPullRequest(BaseModel):
    name: str
    host: str = ols.DEFAULT_HOST
    port: int = ols.DEFAULT_PORT


class ModelDeleteRequest(BaseModel):
    name: str
    host: str = ols.DEFAULT_HOST
    port: int = ols.DEFAULT_PORT


class ProviderRegisterRequest(BaseModel):
    host: str = ols.DEFAULT_HOST
    port: int = ols.DEFAULT_PORT
    name: str = "Ollama"
    enabled: bool = True


class CommandResponse(BaseModel):
    success: bool
    message: str
    status: str = ""


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/status", response_model=OllamaStatusResponse)
async def get_status(host: str = ols.DEFAULT_HOST, port: int = ols.DEFAULT_PORT):
    """Probe the Ollama HTTP server and return its status."""
    status = await ols.get_status(host=host, port=port)
    return OllamaStatusResponse(
        running=status.running,
        port=status.port,
        host=status.host,
        local_models=[
            OllamaModelInfo(
                name=m.name, size=m.size, digest=m.digest,
                parameter_size=m.parameter_size, quantization_level=m.quantization_level,
            )
            for m in status.local_models
        ],
        running_models=[
            OllamaRunningModelInfo(
                name=m.name, size=m.size, vram_size=m.vram_size, expires_at=m.expires_at,
            )
            for m in status.running_models
        ],
        error=status.error,
    )


@router.post("/models/pull", response_model=CommandResponse)
async def pull_model(req: ModelPullRequest):
    """Pull a model from the Ollama library."""
    if not req.name.strip():
        raise HTTPException(status_code=422, detail="name is required")
    result = await ols.pull_model(req.name.strip(), host=req.host, port=req.port)
    return CommandResponse(**result)


@router.post("/models/delete", response_model=CommandResponse)
async def delete_model(req: ModelDeleteRequest):
    """Delete a local model from Ollama."""
    if not req.name.strip():
        raise HTTPException(status_code=422, detail="name is required")
    result = await ols.delete_model(req.name.strip(), host=req.host, port=req.port)
    return CommandResponse(**result)


@router.post("/provider/register", response_model=dict)
def register_provider(req: ProviderRegisterRequest, db: Session = Depends(get_db)):
    """Register the running Ollama server as a ProviderEndpoint in the router DB."""
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
    logger.info("Registered Ollama provider: %s @ %s", req.name, base_url)
    return {"id": row.id, "name": row.name, "base_url": row.base_url, "created": True}
