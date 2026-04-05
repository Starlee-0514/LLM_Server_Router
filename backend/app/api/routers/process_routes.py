"""
API 端點：進程控制 (Start / Stop)

管理 llama-server 的生命週期，支援同時運行多個模型。
"""
import logging
import shlex

from fastapi import APIRouter, HTTPException

from backend.app.core.process_manager import llama_process_manager
from backend.app.schemas import (
    AllProcessesStatus,
    ProcessStartRequest,
    ProcessStatus,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/process", tags=["process"])


@router.post("/start", response_model=ProcessStatus)
def start_model_process(request: ProcessStartRequest):
    """啟動一個 llama-server 進程。支援並行啟動多個模型。"""
    try:
        parsed_extra_args = shlex.split(request.extra_args) if request.extra_args else None
        llama_process_manager.start_server(
            identifier=request.model_identifier,
            model_path=request.model_path,
            engine_type=request.engine_type,
            n_gpu_layers=request.n_gpu_layers,
            batch_size=request.batch_size,
            ubatch_size=request.ubatch_size,
            ctx_size=request.ctx_size,
            extra_args=parsed_extra_args,
        )
    except ValueError as e:
        # 重複啟動
        raise HTTPException(status_code=400, detail=str(e))
    except (RuntimeError, Exception) as e:
        logger.error(f"Failed to start server: {e}")
        raise HTTPException(status_code=500, detail=f"啟動失敗: {str(e)}")

    return llama_process_manager.get_status(request.model_identifier)


@router.post("/stop/{identifier}")
def stop_model_process(identifier: str):
    """停止指定的 llama-server 進程。"""
    success = llama_process_manager.stop_server(identifier)
    if not success:
        raise HTTPException(
            status_code=404,
            detail=f"找不到名為 '{identifier}' 的運行中進程"
        )
    return {"message": f"模型 '{identifier}' 已成功停止"}


@router.get("/status/{identifier}", response_model=ProcessStatus)
def get_process_status(identifier: str):
    """取得單一模型進程狀態。"""
    return llama_process_manager.get_status(identifier)


@router.get("/status", response_model=AllProcessesStatus)
def get_all_status():
    """取得所有運行中的模型狀態。"""
    statuses = llama_process_manager.get_all_status()
    return AllProcessesStatus(
        active_count=len(statuses),
        processes=statuses,
    )
