"""
Virtual Model (Model Alias / Forwarding) API

Virtual models are stable logical aliases — e.g. "coding", "chat", "fast" — that
the router resolves at request time using the routing hints stored here.
Each alias has a RoutePolicy (enum) and optional requirement flags that steer the
route_resolver to the best available backend.

Endpoints:
  GET    /api/virtual-models          - List all virtual models
  POST   /api/virtual-models          - Create a new virtual model alias
  PUT    /api/virtual-models/{id}     - Update an existing alias
  DELETE /api/virtual-models/{id}     - Delete an alias
  GET    /api/virtual-models/policies - Return the RoutePolicy enum values
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import VirtualModel
from backend.app.schemas import RoutePolicy, VirtualModelCreate, VirtualModelResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/virtual-models", tags=["virtual-models"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _row_to_response(vm: VirtualModel) -> VirtualModelResponse:
    return VirtualModelResponse(
        id=vm.id,
        model_id=vm.model_id,
        display_name=vm.display_name or "",
        description=vm.description or "",
        routing_hints_json=vm.routing_hints_json or "{}",
        enabled=bool(vm.enabled),
        created_at=vm.created_at,
        updated_at=vm.updated_at,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/policies")
def list_route_policies():
    """Return all valid RoutePolicy enum values with human-readable labels."""
    labels = {
        RoutePolicy.LOCAL_FIRST: "Local First — prefer on-device/mesh, fall back to cloud",
        RoutePolicy.CHEAPEST: "Cheapest — minimise token cost",
        RoutePolicy.FASTEST: "Fastest — select backend by benchmark tokens/s",
        RoutePolicy.HIGHEST_QUALITY: "Highest Quality — prefer largest / highest-score model",
        RoutePolicy.LOCAL_ONLY: "Local Only — refuse if no local backend available",
        RoutePolicy.REMOTE_ONLY: "Remote Only — always route to a cloud provider",
    }
    return [{"value": v, "label": labels[v]} for v in RoutePolicy.VALID]


@router.get("", response_model=list[VirtualModelResponse])
def list_virtual_models(db: Session = Depends(get_db)):
    """Return all virtual model aliases (enabled and disabled)."""
    rows = db.query(VirtualModel).order_by(VirtualModel.model_id).all()
    return [_row_to_response(r) for r in rows]


@router.post("", response_model=VirtualModelResponse, status_code=201)
def create_virtual_model(payload: VirtualModelCreate, db: Session = Depends(get_db)):
    """Create a new virtual model alias."""
    existing = db.query(VirtualModel).filter(VirtualModel.model_id == payload.model_id).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Virtual model '{payload.model_id}' already exists")

    hints = payload.routing_hints
    if "preferred_policy" in hints and hints["preferred_policy"] not in RoutePolicy.VALID:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid policy '{hints['preferred_policy']}'. Valid values: {sorted(RoutePolicy.VALID)}",
        )

    vm = VirtualModel(
        model_id=payload.model_id.strip(),
        display_name=payload.display_name,
        description=payload.description,
        routing_hints_json=json.dumps(hints),
        enabled=1 if payload.enabled else 0,
    )
    db.add(vm)
    db.commit()
    db.refresh(vm)
    logger.info("Created virtual model: %s", vm.model_id)
    return _row_to_response(vm)


@router.put("/{vm_id}", response_model=VirtualModelResponse)
def update_virtual_model(vm_id: int, payload: VirtualModelCreate, db: Session = Depends(get_db)):
    """Update an existing virtual model alias."""
    vm = db.query(VirtualModel).filter(VirtualModel.id == vm_id).first()
    if not vm:
        raise HTTPException(status_code=404, detail="Virtual model not found")

    # If model_id changed, check for collision
    if vm.model_id != payload.model_id.strip():
        clash = db.query(VirtualModel).filter(
            VirtualModel.model_id == payload.model_id.strip(),
            VirtualModel.id != vm_id,
        ).first()
        if clash:
            raise HTTPException(status_code=409, detail=f"Virtual model '{payload.model_id}' already exists")

    hints = payload.routing_hints
    if "preferred_policy" in hints and hints["preferred_policy"] not in RoutePolicy.VALID:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid policy '{hints['preferred_policy']}'. Valid values: {sorted(RoutePolicy.VALID)}",
        )

    vm.model_id = payload.model_id.strip()
    vm.display_name = payload.display_name
    vm.description = payload.description
    vm.routing_hints_json = json.dumps(hints)
    vm.enabled = 1 if payload.enabled else 0
    db.commit()
    db.refresh(vm)
    logger.info("Updated virtual model %d: %s", vm_id, vm.model_id)
    return _row_to_response(vm)


@router.delete("/{vm_id}", status_code=204)
def delete_virtual_model(vm_id: int, db: Session = Depends(get_db)):
    """Delete a virtual model alias."""
    vm = db.query(VirtualModel).filter(VirtualModel.id == vm_id).first()
    if not vm:
        raise HTTPException(status_code=404, detail="Virtual model not found")
    db.delete(vm)
    db.commit()
    logger.info("Deleted virtual model %d", vm_id)
