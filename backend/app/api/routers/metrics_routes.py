"""API endpoints for dashboard telemetry and summaries."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from backend.app.core.request_stats import request_stats
from backend.app.database import get_db
from backend.app.models import BenchmarkRecord
from backend.app.services.system_metrics import get_memory_metrics, get_gpu_metrics

router = APIRouter(prefix="/api/metrics", tags=["metrics"])


@router.get("/requests")
def get_request_metrics():
    snapshot = request_stats.snapshot()
    total = snapshot.total
    local_ratio = (snapshot.local / total) if total else 0.0
    remote_ratio = (snapshot.remote / total) if total else 0.0
    return {
        "day": snapshot.day,
        "total": total,
        "local": snapshot.local,
        "remote": snapshot.remote,
        "local_ratio": local_ratio,
        "remote_ratio": remote_ratio,
    }


@router.get("/system")
def get_system_metrics():
    return {
        "memory": get_memory_metrics(),
        "gpu": get_gpu_metrics(),
    }


@router.get("/benchmarks/recent")
def get_recent_benchmarks(limit: int = 5, db: Session = Depends(get_db)):
    safe_limit = max(1, min(limit, 20))
    rows = (
        db.query(BenchmarkRecord)
        .order_by(BenchmarkRecord.created_at.desc())
        .limit(safe_limit)
        .all()
    )
    return [
        {
            "id": row.id,
            "model_name": row.model_name,
            "engine_type": row.engine_type,
            "pp_tokens_per_second": row.pp_tokens_per_second,
            "tg_tokens_per_second": row.tg_tokens_per_second,
            "created_at": row.created_at,
        }
        for row in rows
    ]
