"""Shared backend log capture for the Dev monitor + persistent file logging.

Log strategy
------------
* Every server startup creates a timestamped session log file:
      logs/sessions/backend_YYYYMMDD_HHMMSS.log
* logs/backend.log  is a symlink that always points to the latest session.
* Old sessions are auto-pruned (keep the most recent SESSION_KEEP_COUNT).
* DevLogHandler is the *only* component that writes to the log files —
  stdout / stderr are NOT redirected to avoid duplicate entries.
"""

import logging
import os
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
_MAX_LOG_ENTRIES   = 500
_SESSION_KEEP_COUNT = 20   # how many session files to keep

_LOG_DIR = Path(os.environ.get("LLM_ROUTER_LOG_DIR", "logs"))
_SESSION_DIR = _LOG_DIR / "sessions"
_LOG_DIR.mkdir(parents=True, exist_ok=True)
_SESSION_DIR.mkdir(parents=True, exist_ok=True)

# Separate non-session files (always appended, not rotated)
_FRONTEND_LOG_FILE  = _LOG_DIR / "frontend.log"
_PROCESS_LOG_FILE   = _LOG_DIR / "processes.log"
_COMPLETION_LOG_FILE = _LOG_DIR / "completions.log"

_FILE_LOCK = Lock()

# ---------------------------------------------------------------------------
# Per-session backend log
# ---------------------------------------------------------------------------
_SESSION_START_TS = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
_CURRENT_SESSION_FILE = _SESSION_DIR / f"backend_{_SESSION_START_TS}.log"
_BACKEND_LOG_SYMLINK  = _LOG_DIR / "backend.log"

def _init_session() -> None:
    """Create the session log file and update the backend.log symlink."""
    # Write session header
    _CURRENT_SESSION_FILE.touch()
    header = (
        f"# ── Session started {datetime.now(timezone.utc).isoformat()} ──\n"
    )
    _CURRENT_SESSION_FILE.write_text(header, encoding="utf-8")

    # Update symlink: backend.log → sessions/backend_YYYYMMDD_HHMMSS.log
    rel_target = Path("sessions") / _CURRENT_SESSION_FILE.name
    tmp_link = _LOG_DIR / f".backend_{_SESSION_START_TS}.tmp"
    try:
        tmp_link.symlink_to(rel_target)
        tmp_link.replace(_BACKEND_LOG_SYMLINK)   # atomic replace
    except Exception:
        # If symlink fails (e.g. Windows without privilege), fallback to real file
        if not _BACKEND_LOG_SYMLINK.exists():
            _BACKEND_LOG_SYMLINK.touch()

    # Prune old sessions
    _prune_old_sessions()


def _prune_old_sessions() -> None:
    """Remove session files beyond SESSION_KEEP_COUNT (oldest first)."""
    try:
        sessions = sorted(_SESSION_DIR.glob("backend_*.log"))
        for old in sessions[:-_SESSION_KEEP_COUNT]:
            old.unlink(missing_ok=True)
    except Exception:
        pass


_init_session()

# ---------------------------------------------------------------------------
# Thread-safe file append helpers
# ---------------------------------------------------------------------------

def _append_to_file(filepath: Path, line: str) -> None:
    with _FILE_LOCK:
        with open(filepath, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def _append_to_session(line: str) -> None:
    """Append a line to the current session log file."""
    _append_to_file(_CURRENT_SESSION_FILE, line)


# ---------------------------------------------------------------------------
# Public log helpers (called from other modules)
# ---------------------------------------------------------------------------

def log_backend(timestamp: str, level: str, logger_name: str, message: str) -> None:
    _append_to_session(f"[{timestamp}] [{level}] [{logger_name}] {message}")


def log_frontend(timestamp: str, level: str, source: str, message: str) -> None:
    _append_to_file(_FRONTEND_LOG_FILE, f"[{timestamp}] [{level}] [{source}] {message}")


def log_process(identifier: str, message: str) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    _append_to_file(_PROCESS_LOG_FILE, f"[{ts}] [{identifier}] {message}")


def log_completion(
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    total_tokens: int,
    elapsed: float,
    target: str,
    prompt_preview: str,
) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    _append_to_file(
        _COMPLETION_LOG_FILE,
        f"[{ts}] model={model} prompt_tokens={prompt_tokens} "
        f"completion_tokens={completion_tokens} total_tokens={total_tokens} "
        f"elapsed={elapsed:.2f}s target={target} prompt=\"{prompt_preview}\"",
    )
    entry = {
        "timestamp": ts,
        "model": model,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "elapsed": round(elapsed, 2),
        "target": target,
        "prompt_preview": prompt_preview,
    }
    with _DEV_LOG_LOCK:
        _COMPLETION_BUFFER.append(entry)


# ---------------------------------------------------------------------------
# In-memory ring buffers (for /api/dev/logs endpoint)
# ---------------------------------------------------------------------------

_DEV_LOG_BUFFER: deque[dict[str, str]] = deque(maxlen=_MAX_LOG_ENTRIES)
_DEV_LOG_LOCK = Lock()
_COMPLETION_BUFFER: deque[dict] = deque(maxlen=100)


def get_recent_completions(limit: int = 50) -> list[dict]:
    with _DEV_LOG_LOCK:
        items = list(_COMPLETION_BUFFER)
    items.reverse()
    return items[:limit]


def get_log_dir() -> Path:
    return _LOG_DIR


def get_current_session_file() -> Path:
    return _CURRENT_SESSION_FILE


# ---------------------------------------------------------------------------
# Logging handler
# ---------------------------------------------------------------------------

_CAPTURED_PREFIXES = ("backend.",)
_CAPTURED_LOGGERS  = {"httpx", "uvicorn.error"}


def _should_capture(record: logging.LogRecord) -> bool:
    if record.name.startswith("uvicorn.access"):
        return False
    if record.name.startswith(_CAPTURED_PREFIXES):
        return True
    return record.name in _CAPTURED_LOGGERS


class DevLogHandler(logging.Handler):
    """Writes captured log records to the session file + in-memory buffer.

    This is the *only* writer to the session log file.  Do NOT redirect
    uvicorn's stdout/stderr to the same file — that causes duplication.
    """

    def emit(self, record: logging.LogRecord) -> None:
        if not _should_capture(record):
            return

        message = record.getMessage()
        if record.exc_info:
            formatter = logging.Formatter()
            exc_text = formatter.formatException(record.exc_info)
            if exc_text:
                message = f"{message}\n{exc_text}" if message else exc_text

        timestamp = datetime.fromtimestamp(record.created, timezone.utc).isoformat()
        entry = {
            "timestamp": timestamp,
            "level":     record.levelname,
            "logger":    record.name,
            "message":   message,
        }
        with _DEV_LOG_LOCK:
            _DEV_LOG_BUFFER.append(entry)

        log_backend(timestamp, record.levelname, record.name, message)


def install_dev_log_handler(target_logger: logging.Logger | None = None) -> None:
    root = target_logger or logging.getLogger()
    if any(isinstance(h, DevLogHandler) for h in root.handlers):
        return
    root.addHandler(DevLogHandler(level=logging.INFO))


def get_backend_logs(limit: int = 200) -> list[dict[str, str]]:
    with _DEV_LOG_LOCK:
        items = list(_DEV_LOG_BUFFER)
    items.reverse()
    return items[:limit]
