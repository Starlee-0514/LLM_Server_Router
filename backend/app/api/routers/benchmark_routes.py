"""
API 端點：效能測試 Benchmark (基於 llama-bench)

支援即時串流 SSE 與傳統同步兩種模式。
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import BenchmarkRecord
from backend.app.schemas import BenchmarkRunRequest, BenchmarkRecordResponse, BenchmarkImportRequest
from backend.app.services.benchmark_runner import run_benchmark_stream, parse_results

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/benchmarks", tags=["benchmarks"])


@router.get("/history", response_model=list[BenchmarkRecordResponse])
def get_benchmark_history(db: Session = Depends(get_db)):
    """取得所有歷史效能測試紀錄。"""
    return db.query(BenchmarkRecord).order_by(BenchmarkRecord.created_at.desc()).all()


@router.post("/run")
async def run_benchmark_sse(
    request: BenchmarkRunRequest,
    db: Session = Depends(get_db),
):
    """觸發 llama-bench 並以 SSE 即時串流輸出。

    Events:
      event: log   — 即時 log 行 {"line": "..."}
      event: done  — 測試完成 {"results": {...}, "record_id": N}
      event: error — 錯誤 {"error": "..."}
    """

    async def _stream():
        results = {}
        async for event in run_benchmark_stream(
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
        ):
            # Intercept 'done' event to save to DB before forwarding
            if event.startswith("event: done"):
                data_line = event.split("data: ", 1)[1].split("\n")[0]
                results = json.loads(data_line)

                # Save to database
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

                # Enrich the done event with record_id
                results["record_id"] = record.id
                yield f"event: done\ndata: {json.dumps(results)}\n\n"
            elif event.startswith("event: error"):
                yield event
            else:
                yield event

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        },
    )


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
