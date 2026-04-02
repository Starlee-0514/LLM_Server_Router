"""
系統設定 API 路由

端點：
  GET  /api/settings       - 取得所有設定
  GET  /api/settings/{key} - 取得特定設定
  PUT  /api/settings       - 更新設定（批次）
"""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import Setting
from backend.app.schemas import SettingResponse, SettingsBulkUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=list[SettingResponse])
def get_all_settings(db: Session = Depends(get_db)):
    """取得所有系統設定。"""
    settings = db.query(Setting).all()
    return settings


@router.get("/{key}", response_model=SettingResponse)
def get_setting(key: str, db: Session = Depends(get_db)):
    """取得特定 key 的設定值。"""
    setting = db.query(Setting).filter(Setting.key == key).first()
    if setting is None:
        raise HTTPException(status_code=404, detail=f"設定項目 '{key}' 不存在")
    return setting


@router.put("", response_model=list[SettingResponse])
def update_settings(request: SettingsBulkUpdate, db: Session = Depends(get_db)):
    """批次更新設定。

    如果 key 不存在，會自動建立。
    如果 key 已存在，則更新其值。
    """
    results: list[Setting] = []

    for item in request.settings:
        setting = db.query(Setting).filter(Setting.key == item.key).first()

        if setting is None:
            # 新增
            setting = Setting(
                key=item.key,
                value=item.value,
                updated_at=datetime.now(timezone.utc),
            )
            db.add(setting)
            logger.info(f"新增設定: {item.key} = {item.value}")
        else:
            # 更新
            setting.value = item.value
            setting.updated_at = datetime.now(timezone.utc)
            logger.info(f"更新設定: {item.key} = {item.value}")

        results.append(setting)

    db.commit()

    # Refresh to get IDs
    for s in results:
        db.refresh(s)

    return results


@router.delete("/{key}")
def delete_setting(key: str, db: Session = Depends(get_db)):
    """刪除特定 key 的設定。"""
    setting = db.query(Setting).filter(Setting.key == key).first()
    if setting is None:
        raise HTTPException(status_code=404, detail=f"設定項目 '{key}' 不存在")

    db.delete(setting)
    db.commit()

    return {"message": f"設定 '{key}' 已刪除"}
