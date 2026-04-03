"""
API 端點：效能測試 Benchmark (基於 llama-bench)
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import BenchmarkRecord
from backend.app.schemas import BenchmarkRunRequest, BenchmarkRecordResponse, BenchmarkImportRequest
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
            n_prompt=request.n_prompt,
            n_gen=request.n_gen,
            flash_attn=request.flash_attn,
            no_kv_offload=request.no_kv_offload,
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
            raw_output=results.get("raw_output", ""),
        )
        db.add(record)
        db.commit()
        db.refresh(record)
        return record
    except Exception as e:
        logger.error(f"Benchmark run failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/run", response_model=BenchmarkRecordResponse)
async def run_benchmark(
    request: BenchmarkRunRequest,
    db: Session = Depends(get_db)
):
    """觸發一次 llama-bench 效能測試（同步等待完成）。"""
    return await _run_and_save_benchmark(request, db)


@router.delete("/{benchmark_id}")
def delete_benchmark(benchmark_id: int, db: Session = Depends(get_db)):
    """刪除特定的效能測試紀錄。"""
    record = db.query(BenchmarkRecord).filter(BenchmarkRecord.id == benchmark_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="找不到該筆紀錄")
    db.delete(record)
    db.commit()
    return {"message": "已刪除"}


@router.post("/import")
def import_benchmarks(request: BenchmarkImportRequest, db: Session = Depends(get_db)):
    """匯入效能測試紀錄。"""
    imported_count = 0
    for r in request.records:
        record = BenchmarkRecord(
            model_name=r.model_name,
            model_path=r.model_path,
            engine_type=r.engine_type,
            n_gpu_layers=r.n_gpu_layers,
            batch_size=r.batch_size,
            ubatch_size=r.ubatch_size,
            ctx_size=r.ctx_size,
            pp_tokens_per_second=r.pp_tokens_per_second,
            tg_tokens_per_second=r.tg_tokens_per_second,
            raw_output=r.raw_output,
        )
        db.add(record)
        imported_count += 1
    db.commit()
    return {"message": f"成功匯入 {imported_count} 筆紀錄"}
