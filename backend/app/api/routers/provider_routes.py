"""Provider router and mesh worker management APIs."""
import json
import secrets
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import ProviderEndpoint, ModelRoute, MeshWorker
from backend.app.core.provider_helpers import build_provider_headers, build_provider_models_url
from backend.app.core.runtime_settings import (
    get_github_client_id,
    get_github_client_secret,
    get_google_client_id,
    get_google_client_secret,
)
from backend.app.schemas import (
    ProviderEndpointCreate,
    ProviderEndpointResponse,
    ModelRouteCreate,
    ModelRouteResponse,
    MeshWorkerUpsert,
    MeshWorkerResponse,
    CommonProviderTemplate,
    CommonProviderRegisterRequest,
    ProviderModelItem,
)

router = APIRouter(prefix="/api/providers", tags=["providers"])

_oauth_state_store: dict[str, dict] = {}


COMMON_PROVIDER_TEMPLATES: dict[str, dict] = {
    "openrouter": {
        "label": "OpenRouter",
        "provider_type": "openai_compatible",
        "base_url": "https://openrouter.ai/api/v1",
        "auth_hint": "Use OpenRouter API Key",
        "default_extra_headers": "",
    },
    "github_models": {
        "label": "GitHub Models",
        "provider_type": "openai_compatible",
        "base_url": "https://models.inference.ai.azure.com",
        "auth_hint": "Use GitHub token (classic/fine-grained PAT)",
        "default_extra_headers": "",
    },
    "google_gemini_openai": {
        "label": "Google Gemini (OpenAI-compatible)",
        "provider_type": "openai_compatible",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "auth_hint": "Use Google AI Studio API key",
        "default_extra_headers": '{"x-goog-api-key": "<GOOGLE_API_KEY>"}',
    },
}


@router.get("/common/templates", response_model=list[CommonProviderTemplate])
def list_common_provider_templates():
    return [
        CommonProviderTemplate(
            provider_key=key,
            label=value["label"],
            provider_type=value["provider_type"],
            base_url=value["base_url"],
            auth_hint=value["auth_hint"],
            default_extra_headers=value["default_extra_headers"],
        )
        for key, value in COMMON_PROVIDER_TEMPLATES.items()
    ]


@router.post("/common/register", response_model=ProviderEndpointResponse)
def register_common_provider(request: CommonProviderRegisterRequest, db: Session = Depends(get_db)):
    template = COMMON_PROVIDER_TEMPLATES.get(request.provider_key)
    if not template:
        raise HTTPException(status_code=404, detail=f"Unknown provider template: {request.provider_key}")

    if request.provider_key in {"github_models", "google_gemini_openai"}:
        raise HTTPException(
            status_code=400,
            detail="github/google providers must be connected via OAuth login flow",
        )

    provider_name = request.name_override.strip() or request.provider_key
    existing = db.query(ProviderEndpoint).filter(ProviderEndpoint.name == provider_name).first()

    # Google template prefers x-goog-api-key header and leaves Authorization empty.
    extra_headers = template["default_extra_headers"]
    api_key = request.api_key
    if request.provider_key == "google_gemini_openai" and request.api_key:
        extra_headers = json.dumps({"x-goog-api-key": request.api_key})
        api_key = ""

    if existing:
        existing.provider_type = template["provider_type"]
        existing.base_url = template["base_url"]
        existing.api_key = api_key
        existing.extra_headers = extra_headers
        existing.enabled = 1 if request.enabled else 0
        db.commit()
        db.refresh(existing)
        return existing

    row = ProviderEndpoint(
        name=provider_name,
        provider_type=template["provider_type"],
        base_url=template["base_url"],
        api_key=api_key,
        extra_headers=extra_headers,
        enabled=1 if request.enabled else 0,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/common/oauth/start/{provider_key}")
def start_common_provider_oauth(provider_key: str, request: Request, name_override: str = ""):
    if provider_key not in {"github_models", "google_gemini_openai"}:
        raise HTTPException(status_code=400, detail="OAuth login is only supported for github_models/google_gemini_openai")

    callback_url = str(request.url_for("common_provider_oauth_callback", provider_key=provider_key))

    state = secrets.token_urlsafe(24)
    _oauth_state_store[state] = {
        "provider_key": provider_key,
        "name_override": name_override.strip(),
        "redirect_uri": callback_url,
        "created_at": time.time(),
    }

    if provider_key == "github_models":
        client_id = get_github_client_id()
        if not client_id:
            raise HTTPException(status_code=400, detail="Missing github_client_id in settings/env")
        auth_url = "https://github.com/login/oauth/authorize?" + urlencode(
            {
                "client_id": client_id,
                "redirect_uri": callback_url,
                "scope": "read:user",
                "state": state,
            }
        )
        return {"auth_url": auth_url}

    client_id = get_google_client_id()
    if not client_id:
        raise HTTPException(status_code=400, detail="Missing google_client_id in settings/env")
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(
        {
            "client_id": client_id,
            "redirect_uri": callback_url,
            "response_type": "code",
            "scope": "openid email profile https://www.googleapis.com/auth/cloud-platform",
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        }
    )
    return {"auth_url": auth_url}


@router.get("/common/oauth/callback/{provider_key}", name="common_provider_oauth_callback")
async def common_provider_oauth_callback(provider_key: str, code: str = "", state: str = "", error: str = "", db: Session = Depends(get_db)):
    if error:
        return HTMLResponse(f"<html><body><h3>OAuth failed: {error}</h3></body></html>")
    if not code or not state:
        return HTMLResponse("<html><body><h3>OAuth failed: missing code/state</h3></body></html>")

    ctx = _oauth_state_store.pop(state, None)
    if not ctx or ctx.get("provider_key") != provider_key:
        return HTMLResponse("<html><body><h3>OAuth failed: invalid state</h3></body></html>")

    template = COMMON_PROVIDER_TEMPLATES[provider_key]
    provider_name = ctx.get("name_override") or provider_key
    redirect_uri = str(ctx.get("redirect_uri") or "")

    access_token = ""
    extra_headers = template["default_extra_headers"]

    if provider_key == "github_models":
        client_id = get_github_client_id()
        client_secret = get_github_client_secret()
        if not client_id or not client_secret:
            return HTMLResponse("<html><body><h3>OAuth failed: missing github client credentials</h3></body></html>")
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://github.com/login/oauth/access_token",
                headers={"Accept": "application/json"},
                data={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "code": code,
                    "redirect_uri": redirect_uri,
                },
            )
        payload = resp.json()
        access_token = str(payload.get("access_token") or "")
        if not access_token:
            return HTMLResponse("<html><body><h3>OAuth failed: unable to get GitHub access token</h3></body></html>")

    elif provider_key == "google_gemini_openai":
        client_id = get_google_client_id()
        client_secret = get_google_client_secret()
        if not client_id or not client_secret:
            return HTMLResponse("<html><body><h3>OAuth failed: missing google client credentials</h3></body></html>")

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://oauth2.googleapis.com/token",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
            )
        payload = resp.json()
        access_token = str(payload.get("access_token") or "")
        if not access_token:
            return HTMLResponse("<html><body><h3>OAuth failed: unable to get Google access token</h3></body></html>")

    existing = db.query(ProviderEndpoint).filter(ProviderEndpoint.name == provider_name).first()
    if existing:
        existing.provider_type = template["provider_type"]
        existing.base_url = template["base_url"]
        existing.api_key = access_token
        existing.extra_headers = extra_headers
        existing.enabled = 1
        db.commit()
    else:
        row = ProviderEndpoint(
            name=provider_name,
            provider_type=template["provider_type"],
            base_url=template["base_url"],
            api_key=access_token,
            extra_headers=extra_headers,
            enabled=1,
        )
        db.add(row)
        db.commit()

    html = """
    <html><body>
    <h3>OAuth connected successfully. You can close this window.</h3>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'provider-oauth-success' }, '*');
      }
      window.close();
    </script>
    </body></html>
    """
    return HTMLResponse(html)


@router.get("", response_model=list[ProviderEndpointResponse])
def list_providers(db: Session = Depends(get_db)):
    return db.query(ProviderEndpoint).order_by(ProviderEndpoint.created_at.desc()).all()


@router.post("", response_model=ProviderEndpointResponse, status_code=201)
def create_provider(request: ProviderEndpointCreate, db: Session = Depends(get_db)):
    existing = db.query(ProviderEndpoint).filter(ProviderEndpoint.name == request.name).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Provider '{request.name}' already exists")

    row = ProviderEndpoint(
        name=request.name,
        provider_type=request.provider_type,
        base_url=request.base_url,
        api_key=request.api_key,
        extra_headers=request.extra_headers,
        enabled=1 if request.enabled else 0,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/{provider_id}", response_model=ProviderEndpointResponse)
def update_provider(provider_id: int, request: ProviderEndpointCreate, db: Session = Depends(get_db)):
    row = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == provider_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")

    row.name = request.name
    row.provider_type = request.provider_type
    row.base_url = request.base_url
    row.api_key = request.api_key
    row.extra_headers = request.extra_headers
    row.enabled = 1 if request.enabled else 0
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{provider_id}")
def delete_provider(provider_id: int, db: Session = Depends(get_db)):
    row = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == provider_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")

    route_count = db.query(ModelRoute).filter(ModelRoute.provider_id == provider_id).count()
    if route_count > 0:
        raise HTTPException(status_code=409, detail="Provider is still referenced by model routes")

    db.delete(row)
    db.commit()
    return {"message": "Provider deleted"}


@router.get("/{provider_id}/health")
async def provider_health(provider_id: int, db: Session = Depends(get_db)):
    row = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == provider_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")

    if row.provider_type == "local_process":
        return {"ok": True, "provider_type": row.provider_type, "detail": "Managed by local process manager"}

    if not row.base_url:
        raise HTTPException(status_code=400, detail="Provider base_url is empty")

    headers = build_provider_headers(row.api_key or "", row.extra_headers or "")
    url = build_provider_models_url(row.base_url or "")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=headers)
        return {
            "ok": resp.status_code < 400,
            "status_code": resp.status_code,
            "provider": row.name,
            "provider_type": row.provider_type,
            "url": url,
        }
    except httpx.RequestError as e:
        return {
            "ok": False,
            "provider": row.name,
            "provider_type": row.provider_type,
            "url": url,
            "error": str(e),
        }


@router.get("/{provider_id}/models", response_model=list[ProviderModelItem])
async def provider_models(provider_id: int, db: Session = Depends(get_db)):
    row = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == provider_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")

    if row.provider_type == "local_process":
        raise HTTPException(status_code=400, detail="local_process provider does not expose remote models endpoint")

    url = build_provider_models_url(row.base_url or "")
    if not url:
        raise HTTPException(status_code=400, detail="Provider base_url is empty")

    headers = build_provider_headers(row.api_key or "", row.extra_headers or "")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, headers=headers)
        payload = response.json()
        if response.status_code >= 400:
            raise HTTPException(status_code=response.status_code, detail=payload)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Unable to reach provider models endpoint: {e}")

    items = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return []

    models: list[ProviderModelItem] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "")
        if not model_id:
            continue
        models.append(
            ProviderModelItem(
                id=model_id,
                provider_name=row.name,
                raw=item,
            )
        )

    return models


routes_router = APIRouter(prefix="/api/model-routes", tags=["model-routes"])


@routes_router.get("", response_model=list[ModelRouteResponse])
def list_model_routes(db: Session = Depends(get_db)):
    return db.query(ModelRoute).order_by(ModelRoute.priority.asc(), ModelRoute.created_at.asc()).all()


@routes_router.post("", response_model=ModelRouteResponse, status_code=201)
def create_model_route(request: ModelRouteCreate, db: Session = Depends(get_db)):
    existing = db.query(ModelRoute).filter(ModelRoute.route_name == request.route_name).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Model route '{request.route_name}' already exists")

    provider = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == request.provider_id).first()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    row = ModelRoute(
        route_name=request.route_name,
        match_type=request.match_type,
        match_value=request.match_value,
        target_model=request.target_model,
        provider_id=request.provider_id,
        priority=request.priority,
        enabled=1 if request.enabled else 0,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@routes_router.put("/{route_id}", response_model=ModelRouteResponse)
def update_model_route(route_id: int, request: ModelRouteCreate, db: Session = Depends(get_db)):
    row = db.query(ModelRoute).filter(ModelRoute.id == route_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Model route not found")

    provider = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == request.provider_id).first()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    row.route_name = request.route_name
    row.match_type = request.match_type
    row.match_value = request.match_value
    row.target_model = request.target_model
    row.provider_id = request.provider_id
    row.priority = request.priority
    row.enabled = 1 if request.enabled else 0
    db.commit()
    db.refresh(row)
    return row


@routes_router.delete("/{route_id}")
def delete_model_route(route_id: int, db: Session = Depends(get_db)):
    row = db.query(ModelRoute).filter(ModelRoute.id == route_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Model route not found")
    db.delete(row)
    db.commit()
    return {"message": "Model route deleted"}


mesh_router = APIRouter(prefix="/api/mesh/workers", tags=["mesh-workers"])


@mesh_router.get("", response_model=list[MeshWorkerResponse])
def list_workers(db: Session = Depends(get_db)):
    return db.query(MeshWorker).order_by(MeshWorker.updated_at.desc()).all()


@mesh_router.post("/heartbeat", response_model=MeshWorkerResponse)
def upsert_worker_heartbeat(request: MeshWorkerUpsert, db: Session = Depends(get_db)):
    row = db.query(MeshWorker).filter(MeshWorker.node_name == request.node_name).first()
    now = datetime.now(timezone.utc)

    if row is None:
        row = MeshWorker(
            node_name=request.node_name,
            base_url=request.base_url,
            api_token=request.api_token,
            provider_id=request.provider_id,
            models_json=json.dumps(request.models),
            metadata_json=json.dumps(request.metadata),
            status=request.status,
            last_seen_at=now,
        )
        db.add(row)
    else:
        row.base_url = request.base_url
        row.api_token = request.api_token
        row.provider_id = request.provider_id
        row.models_json = json.dumps(request.models)
        row.metadata_json = json.dumps(request.metadata)
        row.status = request.status
        row.last_seen_at = now

    db.commit()
    db.refresh(row)
    return row


@mesh_router.delete("/{worker_id}")
def delete_worker(worker_id: int, db: Session = Depends(get_db)):
    row = db.query(MeshWorker).filter(MeshWorker.id == worker_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Worker not found")
    db.delete(row)
    db.commit()
    return {"message": "Worker deleted"}
