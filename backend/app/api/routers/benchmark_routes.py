"""
API 端點：效能測試 Benchmark (基於 llama-bench)
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import BenchmarkRecord
from backend.app.schemas import BenchmarkRunRequest, BenchmarkRecordResponse
from backend.app.services.benchmark_runner import run_benchmark_async

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/benchmarks", tags=["benchmarks"])


@router.get("/history", response_model=list[BenchmarkRecordResponse])
def get_benchmark_history(db: Session = Depends(get_db)):
    """取得所有歷史效能測試紀錄。"""
    return db.query(BenchmarkRecord).order_by(BenchmarkRecord.created_at.desc()).all()


async def _run_and_save_benchmark(request: BenchmarkRunRequest, db: Session):
    try:
        results = await run_benchmark_async(
            model_name=request.model_name,
            model_path=request.model_path,
            engine_type=request.engine_type,
            n_gpu_layers=request.n_gpu_layers,
            batch_size=request.batch_size,
            ubatch_size=request.ubatch_size,
            ctx_size=request.ctx_size,
        )

        record = BenchmarkRecord(
            model_name=request.model_name,
            model_path=request.model_path,
            engine_type=request.engine_type,
            n_gpu_layers=request.n_gpu_layers,
            batch_size=request.batch_size,
            ubatch_size=request.ubatch_size,
            ctx_size=request.ctx_size,
            pp_tokens_per_second=results.get("pp_tokens_per_second"),
            tg_tokens_per_second=results.get("tg_tokens_per_second"),
        )
        db.add(record)
        db.commit()
    except Exception as e:
        logger.error(f"Benchmark run failed: {e}")


@router.post("/run")
async def run_benchmark(
    request: BenchmarkRunRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    """觸發一次 llama-bench 效能測試。
    測試會在背景非同步執行，完成後將寫入資料庫。
    """
    background_tasks.add_task(_run_and_save_benchmark, request, db)
    return {"message": "Benchmark started in background", "model": request.model_name}
