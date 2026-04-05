"""
運行時環境配置 API 路由

端點：
  GET    /api/runtimes         - 取得所有運行時環境
  GET    /api/runtimes/{id}    - 取得特定運行時環境
  POST   /api/runtimes         - 建立新的運行時環境
  PUT    /api/runtimes/{id}    - 更新運行時環境
  DELETE /api/runtimes/{id}    - 刪除運行時環境
"""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import ModelGroup, Runtime, Setting
from backend.app.schemas import RuntimeResponse, RuntimeCreate, RuntimeUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/runtimes", tags=["runtimes"])


@router.get("", response_model=list[RuntimeResponse])
def get_all_runtimes(db: Session = Depends(get_db)):
    """取得所有運行時環境配置。"""
    runtimes = db.query(Runtime).order_by(Runtime.name).all()
    return runtimes


@router.get("/{runtime_id}", response_model=RuntimeResponse)
def get_runtime(runtime_id: int, db: Session = Depends(get_db)):
    """取得特定運行時環境配置。"""
    runtime = db.query(Runtime).filter(Runtime.id == runtime_id).first()
    if runtime is None:
        raise HTTPException(status_code=404, detail=f"運行時環境 ID {runtime_id} 不存在")
    return runtime


@router.post("", response_model=RuntimeResponse)
def create_runtime(request: RuntimeCreate, db: Session = Depends(get_db)):
    """建立新的運行時環境配置。"""
    # 檢查名稱是否已存在
    existing = db.query(Runtime).filter(Runtime.name == request.name).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"運行時環境名稱 '{request.name}' 已存在")

    runtime = Runtime(
        name=request.name,
        description=request.description,
        executable_path=request.executable_path,
        environment_vars=request.environment_vars,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(runtime)
    db.commit()
    db.refresh(runtime)
    logger.info(f"建立運行時環境: {request.name}")
    return runtime


@router.put("/{runtime_id}", response_model=RuntimeResponse)
def update_runtime(runtime_id: int, request: RuntimeUpdate, db: Session = Depends(get_db)):
    """更新運行時環境配置。"""
    runtime = db.query(Runtime).filter(Runtime.id == runtime_id).first()
    if runtime is None:
        raise HTTPException(status_code=404, detail=f"運行時環境 ID {runtime_id} 不存在")

    original_name = runtime.name

    # 檢查新名稱是否與其他已存在的衝突
    if request.name and request.name != runtime.name:
        existing = db.query(Runtime).filter(Runtime.name == request.name).first()
        if existing:
            raise HTTPException(status_code=409, detail=f"運行時環境名稱 '{request.name}' 已存在")
        runtime.name = request.name

    if request.description is not None:
        runtime.description = request.description
    if request.executable_path is not None:
        runtime.executable_path = request.executable_path
    if request.environment_vars is not None:
        runtime.environment_vars = request.environment_vars

    if runtime.name != original_name:
        db.query(ModelGroup).filter(ModelGroup.engine_type == original_name).update(
            {ModelGroup.engine_type: runtime.name},
            synchronize_session=False,
        )

        default_engine = db.query(Setting).filter(Setting.key == "default_engine").first()
        if default_engine and default_engine.value == original_name:
            default_engine.value = runtime.name

    runtime.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(runtime)
    logger.info(f"更新運行時環境: {runtime.name}")
    return runtime


@router.delete("/{runtime_id}")
def delete_runtime(runtime_id: int, db: Session = Depends(get_db)):
    """刪除運行時環境配置。"""
    runtime = db.query(Runtime).filter(Runtime.id == runtime_id).first()
    if runtime is None:
        raise HTTPException(status_code=404, detail=f"運行時環境 ID {runtime_id} 不存在")

    using_groups = db.query(ModelGroup).filter(ModelGroup.engine_type == runtime.name).first()
    if using_groups:
        raise HTTPException(
            status_code=409,
            detail=f"無法刪除運行時環境 '{runtime.name}'，還有模型組(Model Group)在使用它。請先更新或刪除這些模型組。",
        )

    default_engine = db.query(Setting).filter(Setting.key == "default_engine").first()
    if default_engine and default_engine.value == runtime.name:
        replacement = (
            db.query(Runtime)
            .filter(Runtime.id != runtime.id)
            .order_by(Runtime.name)
            .first()
        )
        default_engine.value = replacement.name if replacement else ""

    db.delete(runtime)
    db.commit()
    logger.info(f"刪除運行時環境: {runtime.name}")
    return {"message": f"運行時環境 '{runtime.name}' 已刪除"}
