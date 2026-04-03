"""
API 端點：模型群組管理 (ModelGroup CRUD)

讓使用者可以預先設定好一組「模型 + 參數」的組合，
日後只需要一鍵即可啟動 llama-server。
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import ModelGroup
from backend.app.schemas import ModelGroupCreate, ModelGroupResponse
from backend.app.core.process_manager import llama_process_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/model-groups", tags=["model-groups"])


@router.get("", response_model=list[ModelGroupResponse])
def list_model_groups(db: Session = Depends(get_db)):
    """取得所有已儲存的模型群組。"""
    return db.query(ModelGroup).order_by(ModelGroup.created_at.desc()).all()


@router.get("/{group_id}", response_model=ModelGroupResponse)
def get_model_group(group_id: int, db: Session = Depends(get_db)):
    """取得特定模型群組的詳細資訊。"""
    group = db.query(ModelGroup).filter(ModelGroup.id == group_id).first()
    if group is None:
        raise HTTPException(status_code=404, detail=f"模型群組 ID={group_id} 不存在")
    return group


@router.post("", response_model=ModelGroupResponse, status_code=201)
def create_model_group(request: ModelGroupCreate, db: Session = Depends(get_db)):
    """建立新的模型群組。

    預先設定好模型路徑與啟動參數，日後一鍵啟動。
    """
    existing = db.query(ModelGroup).filter(ModelGroup.name == request.name).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"模型設定檔名稱 '{request.name}' 已存在")

    group = ModelGroup(
        group_name=request.group_name,
        name=request.name,
        description=request.description,
        model_path=request.model_path,
        engine_type=request.engine_type,
        n_gpu_layers=request.n_gpu_layers,
        batch_size=request.batch_size,
        ubatch_size=request.ubatch_size,
        ctx_size=request.ctx_size,
        extra_args=request.extra_args,
    )
    db.add(group)
    db.commit()
    db.refresh(group)

    logger.info(f"建立模型群組: {request.group_name} / {request.name} -> {request.model_path}")
    return group


@router.put("/{group_id}", response_model=ModelGroupResponse)
def update_model_group(
    group_id: int,
    request: ModelGroupCreate,
    db: Session = Depends(get_db),
):
    """更新模型群組設定。"""
    group = db.query(ModelGroup).filter(ModelGroup.id == group_id).first()
    if group is None:
        raise HTTPException(status_code=404, detail=f"模型群組 ID={group_id} 不存在")

    group.group_name = request.group_name
    group.name = request.name
    group.description = request.description
    group.model_path = request.model_path
    group.engine_type = request.engine_type
    group.n_gpu_layers = request.n_gpu_layers
    group.batch_size = request.batch_size
    group.ubatch_size = request.ubatch_size
    group.ctx_size = request.ctx_size
    group.extra_args = request.extra_args

    db.commit()
    db.refresh(group)
    return group


@router.delete("/{group_id}")
def delete_model_group(group_id: int, db: Session = Depends(get_db)):
    """刪除模型群組。"""
    group = db.query(ModelGroup).filter(ModelGroup.id == group_id).first()
    if group is None:
        raise HTTPException(status_code=404, detail=f"模型群組 ID={group_id} 不存在")

    db.delete(group)
    db.commit()
    return {"message": f"模型群組 '{group.name}' 已刪除"}


@router.post("/{group_id}/launch")
def launch_model_group(group_id: int, db: Session = Depends(get_db)):
    """一鍵啟動模型群組中預設的模型與參數。

    從資料庫讀取已存的設定，直接啟動 llama-server。
    """
    group = db.query(ModelGroup).filter(ModelGroup.id == group_id).first()
    if group is None:
        raise HTTPException(status_code=404, detail=f"模型群組 ID={group_id} 不存在")

    try:
        llama_process_manager.start_server(
            identifier=group.name,
            model_path=group.model_path,
            engine_type=group.engine_type,
            n_gpu_layers=group.n_gpu_layers,
            batch_size=group.batch_size,
            ubatch_size=group.ubatch_size,
            ctx_size=group.ctx_size,
            extra_args=group.extra_args.split() if group.extra_args else None,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    status = llama_process_manager.get_status(group.name)
    return {
        "message": f"模型群組 '{group.name}' 已啟動",
        "process": status,
    }
