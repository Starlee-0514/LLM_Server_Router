"""Provider router and mesh worker management APIs."""
import json
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import ProviderEndpoint, ModelRoute, MeshWorker
from backend.app.schemas import (
    ProviderEndpointCreate,
    ProviderEndpointResponse,
    ModelRouteCreate,
    ModelRouteResponse,
    MeshWorkerUpsert,
    MeshWorkerResponse,
)

router = APIRouter(prefix="/api/providers", tags=["providers"])


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

    headers = {}
    if row.api_key:
        headers["Authorization"] = f"Bearer {row.api_key}"

    if row.extra_headers:
        try:
            parsed = json.loads(row.extra_headers)
            if isinstance(parsed, dict):
                headers.update({str(k): str(v) for k, v in parsed.items()})
        except Exception:
            pass

    url = row.base_url.rstrip("/") + "/v1/models"
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
