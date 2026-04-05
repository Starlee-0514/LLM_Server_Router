"""Developer / monitoring endpoints — process events, live logs, benchmark progress."""
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, JSONResponse

from backend.app.core.dev_logs import get_backend_logs, log_frontend, get_log_dir, get_recent_completions
from backend.app.core.process_manager import llama_process_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dev", tags=["dev"])


@router.get("/events")
def get_process_events(limit: int = Query(100, ge=1, le=500)):
    """Return recent process lifecycle events (newest first)."""
    return llama_process_manager.get_event_log(limit)


@router.get("/logs")
def get_service_logs(limit: int = Query(200, ge=1, le=500)):
    """Return recent backend service log lines (newest first)."""
    return get_backend_logs(limit)


@router.get("/processes")
def get_process_details():
    """Return detailed info for every active process including cmd, env, and port."""
    statuses = llama_process_manager.get_all_status()
    enriched = []
    for st in statuses:
        idf = st["identifier"]
        rp = llama_process_manager._active_processes.get(idf)
        cmd_str = ""
        if rp and rp.process.args:
            if isinstance(rp.process.args, list):
                import shlex
                cmd_str = shlex.join(rp.process.args)
            else:
                cmd_str = str(rp.process.args)
        enriched.append({
            **st,
            "command": cmd_str,
            "phase": getattr(rp, "phase", None) if rp else None,
            "recent_output": list(getattr(rp, "recent_output", [])) if rp else [],
        })
    return enriched


@router.post("/logs/frontend")
async def receive_frontend_logs(request: Request):
    """Receive and persist frontend log entries.
    
    Expects JSON body: {"logs": [{"timestamp": "...", "level": "...", "source": "...", "message": "..."}]}
    """
    body = await request.json()
    entries = body.get("logs", [])
    if not isinstance(entries, list):
        return JSONResponse(status_code=400, content={"error": "Expected 'logs' array"})
    
    for entry in entries[:100]:  # cap at 100 entries per request
        log_frontend(
            entry.get("timestamp", datetime.now(timezone.utc).isoformat()),
            entry.get("level", "INFO"),
            entry.get("source", "frontend"),
            entry.get("message", ""),
        )
    return {"received": len(entries)}


@router.get("/logs/files")
def list_log_files():
    """List all log files in the logs directory with their sizes."""
    log_dir = get_log_dir()
    files = []
    for f in sorted(log_dir.iterdir()):
        if f.is_file() and f.suffix == ".log":
            stat = f.stat()
            files.append({
                "name": f.name,
                "size_bytes": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            })
    return files


@router.get("/logs/files/{filename}")
def download_log_file(filename: str):
    """Download a specific log file. Only allows .log files from the log directory."""
    # Sanitize filename to prevent path traversal
    safe_name = Path(filename).name
    if not safe_name.endswith(".log"):
        return JSONResponse(status_code=400, content={"error": "Only .log files allowed"})
    
    filepath = get_log_dir() / safe_name
    if not filepath.exists():
        return JSONResponse(status_code=404, content={"error": f"Log file '{safe_name}' not found"})
    
    return FileResponse(filepath, media_type="text/plain", filename=safe_name)


@router.get("/completions")
def get_completions(limit: int = Query(50, ge=1, le=200)):
    """Return recent completion records with structured token/prompt data."""
    return get_recent_completions(limit)
