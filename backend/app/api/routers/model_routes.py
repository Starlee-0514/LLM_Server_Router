"""
模型管理 API 路由

端點：
  GET  /api/models/scan  - 掃描已設定目錄中的 GGUF 檔案
  POST /api/models/scan  - 掃描指定目錄中的 GGUF 檔案（臨時掃描）
"""
import json
import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import Setting
from backend.app.schemas import ModelScanRequest, ModelScanResponse
from backend.app.services.model_scanner import scan_directories

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/models", tags=["models"])


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

    return ModelScanResponse(
        total_count=len(models),
        scanned_directories=directories,
        models=models,
        errors=errors,
    )


@router.post("/scan", response_model=ModelScanResponse)
def scan_custom_directories(request: ModelScanRequest):
    """掃描使用者指定的目錄，回傳 GGUF 模型清單。

    注意：此端點不會修改設定，僅為一次性掃描。
    """
    models, errors = scan_directories(request.directories)

    return ModelScanResponse(
        total_count=len(models),
        scanned_directories=request.directories,
        models=models,
        errors=errors,
    )
