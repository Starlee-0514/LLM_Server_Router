"""
模型管理 API 路由

端點：
  GET  /api/models/scan  - 掃描已設定目錄中的 GGUF 檔案
  POST /api/models/scan  - 掃描指定目錄中的 GGUF 檔案（臨時掃描）
  GET  /api/models/overrides       - 取得所有屬性覆寫
  PUT  /api/models/overrides       - 建立或更新模型屬性覆寫
  DELETE /api/models/overrides/{id} - 刪除模型屬性覆寫
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import Setting, ModelPropertyOverride
from backend.app.schemas import (
    ModelScanRequest,
    ModelScanResponse,
    ModelPropertyOverrideCreate,
    ModelPropertyOverrideResponse,
)
from backend.app.services.model_scanner import scan_directories

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/models", tags=["models"])


def _apply_overrides(models, db: Session):
    """Apply user overrides to scanned models in-place."""
    overrides = db.query(ModelPropertyOverride).all()
    override_map = {o.filepath: o for o in overrides}
    for m in models:
        o = override_map.get(m.filepath)
        if not o:
            continue
        if o.publisher:
            m.publisher = o.publisher
        if o.quantize:
            m.quantize = o.quantize
        if o.param_size:
            m.param_size = o.param_size
        if o.arch:
            m.arch = o.arch
        if o.model_family:
            m.model_family = o.model_family


@router.get("/scan", response_model=ModelScanResponse)
def scan_configured_directories(db: Session = Depends(get_db)):
    """掃描已在設定中配置的目錄，回傳所有 GGUF 模型清單。

    從 SQLite settings 表讀取 key="model_scan_dirs" 的值（JSON 陣列），
    然後掃描每個目錄下的 .gguf 檔案。
    """
    setting = db.query(Setting).filter(Setting.key == "model_scan_dirs").first()

    if setting is None or not setting.value:
        return ModelScanResponse(
            total_count=0,
            scanned_directories=[],
            models=[],
            errors=["尚未配置掃描目錄。請透過 PUT /api/settings 設定 model_scan_dirs。"],
        )

    try:
        directories = json.loads(setting.value)
        if not isinstance(directories, list):
            raise ValueError("model_scan_dirs 必須是 JSON 陣列")
    except (json.JSONDecodeError, ValueError) as e:
        return ModelScanResponse(
            total_count=0,
            scanned_directories=[],
            models=[],
            errors=[f"model_scan_dirs 設定格式錯誤: {e}"],
        )

    models, errors = scan_directories(directories)
    _apply_overrides(models, db)

    return ModelScanResponse(
        total_count=len(models),
        scanned_directories=directories,
        models=models,
        errors=errors,
    )


@router.post("/scan", response_model=ModelScanResponse)
def scan_custom_directories(request: ModelScanRequest, db: Session = Depends(get_db)):
    """掃描使用者指定的目錄，回傳 GGUF 模型清單。

    注意：此端點不會修改設定，僅為一次性掃描。
    """
    models, errors = scan_directories(request.directories)
    _apply_overrides(models, db)

    return ModelScanResponse(
        total_count=len(models),
        scanned_directories=request.directories,
        models=models,
        errors=errors,
    )


# =====================
# Model Property Overrides
# =====================
@router.get("/overrides", response_model=list[ModelPropertyOverrideResponse])
def get_overrides(db: Session = Depends(get_db)):
    """取得所有模型屬性覆寫。"""
    return db.query(ModelPropertyOverride).order_by(ModelPropertyOverride.filepath).all()


@router.put("/overrides", response_model=ModelPropertyOverrideResponse)
def upsert_override(payload: ModelPropertyOverrideCreate, db: Session = Depends(get_db)):
    """建立或更新模型屬性覆寫（以 filepath 為 key）。"""
    existing = db.query(ModelPropertyOverride).filter(
        ModelPropertyOverride.filepath == payload.filepath
    ).first()

    if existing:
        existing.display_name = payload.display_name
        existing.publisher = payload.publisher
        existing.quantize = payload.quantize
        existing.param_size = payload.param_size
        existing.arch = payload.arch
        existing.model_family = payload.model_family
        existing.tags = payload.tags
        existing.notes = payload.notes
        db.commit()
        db.refresh(existing)
        return existing
    else:
        new_override = ModelPropertyOverride(
            filepath=payload.filepath,
            display_name=payload.display_name,
            publisher=payload.publisher,
            quantize=payload.quantize,
            param_size=payload.param_size,
            arch=payload.arch,
            model_family=payload.model_family,
            tags=payload.tags,
            notes=payload.notes,
        )
        db.add(new_override)
        db.commit()
        db.refresh(new_override)
        return new_override


@router.delete("/overrides/{override_id}")
def delete_override(override_id: int, db: Session = Depends(get_db)):
    """刪除模型屬性覆寫。"""
    record = db.query(ModelPropertyOverride).filter(ModelPropertyOverride.id == override_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Override not found")
    db.delete(record)
    db.commit()
    return {"message": "Deleted"}
