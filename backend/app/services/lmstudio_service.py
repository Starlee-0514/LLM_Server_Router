"""
LM Studio service — wraps the `lms` CLI for server and model management.

LM Studio exposes an OpenAI-compatible REST API (default port 1234).
Health endpoint: GET /lmstudio-greeting  →  { "lmstudio": true }

`lms` CLI commands used here:
  lms server start [--port N] [--bind 0.0.0.0]
  lms server stop
  lms status --json          (JSON output — not always supported, fallback to HTTP probe)
  lms list                   (lists available/downloaded models)
  lms load <identifier>      (load a model into VRAM)
  lms unload [identifier]    (unload; --all for all)
"""
import asyncio
import json
import logging
import shutil
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)

DEFAULT_PORT = 1234
DEFAULT_HOST = "127.0.0.1"
GREETING_PATH = "/lmstudio-greeting"
PROBE_TIMEOUT = 3.0


# ---------------------------------------------------------------------------
# Helper: locate the `lms` binary
# ---------------------------------------------------------------------------

def _lms_executable() -> str:
    """Find the `lms` binary on PATH, raise RuntimeError if not found."""
    exe = shutil.which("lms")
    if exe:
        return exe
    # Common npm global install locations
    for candidate in [
        "/usr/local/bin/lms",
        "/usr/bin/lms",
        f"{__import__('os').path.expanduser('~')}/.local/bin/lms",
        f"{__import__('os').path.expanduser('~')}/.npm-global/bin/lms",
        f"{__import__('os').path.expanduser('~')}/.nvm/versions/node/current/bin/lms",
    ]:
        import os
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise RuntimeError(
        "lms CLI not found. Install via: npm install -g @lmstudio/lms  "
        "then ensure it is on PATH."
    )


async def _run(args: list[str], timeout: float = 30.0) -> tuple[int, str, str]:
    """Run `lms <args>` and return (returncode, stdout, stderr)."""
    exe = _lms_executable()
    proc = await asyncio.create_subprocess_exec(
        exe, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return -1, "", f"lms {' '.join(args)} timed out after {timeout}s"
    return proc.returncode, stdout_b.decode(errors="replace"), stderr_b.decode(errors="replace")


# ---------------------------------------------------------------------------
# Server probe
# ---------------------------------------------------------------------------

@dataclass
class LMStudioStatus:
    running: bool
    port: int
    host: str
    loaded_models: list[str] = field(default_factory=list)
    available_models: list[str] = field(default_factory=list)
    error: str = ""


async def probe_server(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> bool:
    """Return True if the LM Studio HTTP server is responding."""
    url = f"http://{host}:{port}{GREETING_PATH}"
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
            resp = await client.get(url)
            data = resp.json()
            return bool(data.get("lmstudio"))
    except Exception:
        return False


async def get_status(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> LMStudioStatus:
    """Probe server + fetch models list if running."""
    running = await probe_server(host, port)
    if not running:
        return LMStudioStatus(running=False, port=port, host=host)

    loaded: list[str] = []
    available: list[str] = []

    # Try GET /v1/models for currently-loaded models
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"http://{host}:{port}/v1/models")
            if resp.status_code == 200:
                data = resp.json()
                loaded = [m.get("id", "") for m in data.get("data", []) if m.get("id")]
    except Exception:
        pass

    return LMStudioStatus(
        running=True,
        port=port,
        host=host,
        loaded_models=loaded,
        available_models=available,
    )


# ---------------------------------------------------------------------------
# Server start / stop
# ---------------------------------------------------------------------------

@dataclass
class CommandResult:
    success: bool
    message: str
    stdout: str = ""
    stderr: str = ""


async def server_start(port: int = DEFAULT_PORT, bind: str | None = None) -> CommandResult:
    """Start the LM Studio HTTP server via `lms server start`."""
    args = ["server", "start", "--port", str(port), "--cors"]
    if bind:
        args += ["--bind", bind]
    code, out, err = await _run(args, timeout=15.0)
    if code == 0:
        return CommandResult(success=True, message=f"Server started on port {port}", stdout=out, stderr=err)
    # Already running is not an error
    if "already" in out.lower() or "already" in err.lower():
        return CommandResult(success=True, message="Server already running", stdout=out, stderr=err)
    return CommandResult(success=False, message=f"Failed to start server (exit {code})", stdout=out, stderr=err)


async def server_stop() -> CommandResult:
    """Stop the LM Studio HTTP server via `lms server stop`."""
    code, out, err = await _run(["server", "stop"], timeout=15.0)
    if code == 0:
        return CommandResult(success=True, message="Server stopped", stdout=out, stderr=err)
    return CommandResult(success=False, message=f"Failed to stop server (exit {code})", stdout=out, stderr=err)


# ---------------------------------------------------------------------------
# Model load / unload
# ---------------------------------------------------------------------------

async def model_load(identifier: str, gpu: float | None = None, ctx_length: int | None = None) -> CommandResult:
    """Load a model via `lms load <identifier>`."""
    args = ["load", identifier, "--yes"]
    if gpu is not None:
        args += ["--gpu", str(gpu)]
    if ctx_length is not None:
        args += ["--context-length", str(ctx_length)]
    code, out, err = await _run(args, timeout=120.0)
    if code == 0:
        return CommandResult(success=True, message=f"Model '{identifier}' loaded", stdout=out, stderr=err)
    return CommandResult(success=False, message=f"Failed to load model (exit {code})", stdout=out, stderr=err)


async def model_unload(identifier: str | None = None, unload_all: bool = False) -> CommandResult:
    """Unload a model via `lms unload [identifier|--all]`."""
    args = ["unload"]
    if unload_all:
        args.append("--all")
    elif identifier:
        args.append(identifier)
    else:
        return CommandResult(success=False, message="Provide an identifier or set unload_all=True")
    code, out, err = await _run(args, timeout=30.0)
    if code == 0:
        return CommandResult(success=True, message="Model(s) unloaded", stdout=out, stderr=err)
    return CommandResult(success=False, message=f"Failed to unload (exit {code})", stdout=out, stderr=err)


# ---------------------------------------------------------------------------
# Check whether lms is installed
# ---------------------------------------------------------------------------

def lms_available() -> bool:
    """Return True if the `lms` binary can be found."""
    try:
        _lms_executable()
        return True
    except RuntimeError:
        return False
