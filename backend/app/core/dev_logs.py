"""Shared backend log capture for the Dev monitor + persistent file logging."""

import logging
import os
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

_MAX_LOG_ENTRIES = 500
_DEV_LOG_BUFFER: deque[dict[str, str]] = deque(maxlen=_MAX_LOG_ENTRIES)
_DEV_LOG_LOCK = Lock()
_CAPTURED_PREFIXES = ("backend.",)
_CAPTURED_LOGGERS = {"httpx", "uvicorn.error"}

# ---------------------------------------------------------------------------
# Persistent log directory — all logs written here for debug
# ---------------------------------------------------------------------------
_LOG_DIR = Path(os.environ.get("LLM_ROUTER_LOG_DIR", "logs"))
_LOG_DIR.mkdir(parents=True, exist_ok=True)

# Separate log files
_BACKEND_LOG_FILE = _LOG_DIR / "backend.log"
_FRONTEND_LOG_FILE = _LOG_DIR / "frontend.log"
_PROCESS_LOG_FILE = _LOG_DIR / "processes.log"
_COMPLETION_LOG_FILE = _LOG_DIR / "completions.log"

_FILE_LOCK = Lock()


def _append_to_file(filepath: Path, line: str) -> None:
    """Append a single line to a log file (thread-safe)."""
    with _FILE_LOCK:
        with open(filepath, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def log_backend(timestamp: str, level: str, logger_name: str, message: str) -> None:
    """Write a backend log entry to the persistent log file."""
    _append_to_file(_BACKEND_LOG_FILE, f"[{timestamp}] [{level}] [{logger_name}] {message}")


def log_frontend(timestamp: str, level: str, source: str, message: str) -> None:
    """Write a frontend log entry to the persistent log file."""
    _append_to_file(_FRONTEND_LOG_FILE, f"[{timestamp}] [{level}] [{source}] {message}")


def log_process(identifier: str, message: str) -> None:
    """Write a process output line to the persistent log file."""
    ts = datetime.now(timezone.utc).isoformat()
    _append_to_file(_PROCESS_LOG_FILE, f"[{ts}] [{identifier}] {message}")


def log_completion(model: str, prompt_tokens: int, completion_tokens: int, 
                   total_tokens: int, elapsed: float, target: str, prompt_preview: str) -> None:
    """Write a completion record to the persistent log file."""
    ts = datetime.now(timezone.utc).isoformat()
    _append_to_file(
        _COMPLETION_LOG_FILE,
        f"[{ts}] model={model} prompt_tokens={prompt_tokens} completion_tokens={completion_tokens} "
        f"total_tokens={total_tokens} elapsed={elapsed:.2f}s target={target} prompt=\"{prompt_preview}\""
    )
    # Also store in ring buffer for API access
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


_COMPLETION_BUFFER: deque[dict] = deque(maxlen=100)


def get_recent_completions(limit: int = 50) -> list[dict]:
    """Return recent completion records (newest first)."""
    with _DEV_LOG_LOCK:
        items = list(_COMPLETION_BUFFER)
    items.reverse()
    return items[:limit]


def get_log_dir() -> Path:
    """Return the log directory path."""
    return _LOG_DIR


def _should_capture(record: logging.LogRecord) -> bool:
    if record.name.startswith("uvicorn.access"):
        return False
    if record.name.startswith(_CAPTURED_PREFIXES):
        return True
    return record.name in _CAPTURED_LOGGERS


class DevLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        if not _should_capture(record):
            return

        message = record.getMessage()
        if record.exc_info:
            formatter = logging.Formatter()
            exception_text = formatter.formatException(record.exc_info)
            if exception_text:
                message = f"{message}\n{exception_text}" if message else exception_text

        timestamp = datetime.fromtimestamp(record.created, timezone.utc).isoformat()
        entry = {
            "timestamp": timestamp,
            "level": record.levelname,
            "logger": record.name,
            "message": message,
        }
        with _DEV_LOG_LOCK:
            _DEV_LOG_BUFFER.append(entry)

        # Also persist to file
        log_backend(timestamp, record.levelname, record.name, message)


def install_dev_log_handler(target_logger: logging.Logger | None = None) -> None:
    logger = target_logger or logging.getLogger()
    if any(isinstance(handler, DevLogHandler) for handler in logger.handlers):
        return

    handler = DevLogHandler(level=logging.INFO)
    logger.addHandler(handler)


def get_backend_logs(limit: int = 200) -> list[dict[str, str]]:
    with _DEV_LOG_LOCK:
        items = list(_DEV_LOG_BUFFER)
    items.reverse()
    return items[:limit]