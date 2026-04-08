"""API endpoints for dashboard telemetry and summaries."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.app.core.request_stats import request_stats
from backend.app.database import get_db
from backend.app.models import BenchmarkRecord, CompletionLog
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


@router.get("/provider-usage")
def get_provider_usage(
    provider_name: str = Query(default=""),
    conversation_id: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    """Per-provider and per-conversation token usage analytics.

    Returns aggregated request counts and token usage broken down by provider.
    Optionally filter by provider_name or conversation_id.
    """
    query = db.query(
        CompletionLog.provider_name,
        CompletionLog.conversation_id,
        func.count(CompletionLog.id).label("request_count"),
        func.sum(CompletionLog.prompt_tokens).label("total_prompt_tokens"),
        func.sum(CompletionLog.completion_tokens).label("total_completion_tokens"),
        func.sum(CompletionLog.total_tokens).label("total_tokens"),
        func.sum(CompletionLog.tool_calls_count).label("total_tool_calls"),
        func.avg(CompletionLog.latency_ms).label("avg_latency_ms"),
    )

    if provider_name:
        query = query.filter(CompletionLog.provider_name == provider_name)
    if conversation_id:
        query = query.filter(CompletionLog.conversation_id == conversation_id)

    rows = (
        query
        .group_by(CompletionLog.provider_name, CompletionLog.conversation_id)
        .order_by(func.count(CompletionLog.id).desc())
        .limit(limit)
        .all()
    )

    return [
        {
            "provider_name": r.provider_name or "",
            "conversation_id": r.conversation_id or "",
            "request_count": r.request_count,
            "total_prompt_tokens": r.total_prompt_tokens or 0,
            "total_completion_tokens": r.total_completion_tokens or 0,
            "total_tokens": r.total_tokens or 0,
            "total_tool_calls": r.total_tool_calls or 0,
            "avg_latency_ms": round(r.avg_latency_ms or 0, 1),
        }
        for r in rows
    ]
