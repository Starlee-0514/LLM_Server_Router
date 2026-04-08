"""Web terminal WebSocket endpoint with zellij session management.

Spawns a PTY-backed shell (or zellij) and bridges it over a WebSocket
so the frontend can display a full terminal emulator via xterm.js.

Sessions persist after disconnect — users can reattach to existing sessions.
REST endpoints allow listing, creating, and deleting sessions.
"""
import asyncio
import fcntl
import json
import logging
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import termios

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/terminal", tags=["terminal"])

# Which shell to spawn.  Prefer zellij if available.
_ZELLIJ = shutil.which("zellij")
_DEFAULT_SHELL = os.environ.get("SHELL", "/bin/bash")

# Track which sessions currently have an active WebSocket attached
_attached_sessions: dict[str, bool] = {}  # session_name -> True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _list_zellij_sessions() -> list[dict]:
    """Return a list of zellij sessions with name and status."""
    if not _ZELLIJ:
        return []
    try:
        result = subprocess.run(
            [_ZELLIJ, "list-sessions"],
            capture_output=True, text=True, timeout=5,
        )
        sessions = []
        for line in result.stdout.strip().splitlines():
            if not line.strip():
                continue
            # Strip ANSI escape codes
            clean_line = _ANSI_ESCAPE_RE.sub("", line.strip())
            # zellij list-sessions output: "session_name [Created ... ago]"
            parts = clean_line.split()
            name = parts[0] if parts else clean_line
            name = name.strip()
            if not name:
                continue
            is_attached = _attached_sessions.get(name, False)
            sessions.append({
                "name": name,
                "attached": is_attached,
                "raw": clean_line,
            })
        return sessions
    except Exception as e:
        logger.warning("Failed to list zellij sessions: %s", e)
        return []


def _kill_zellij_session(session_name: str) -> None:
    """Kill a named zellij session."""
    if not _ZELLIJ or not session_name:
        return
    try:
        subprocess.run(
            [_ZELLIJ, "kill-session", session_name],
            timeout=5, capture_output=True,
        )
        _attached_sessions.pop(session_name, None)
        logger.info("Killed zellij session: %s", session_name)
    except Exception as e:
        logger.warning("Failed to kill zellij session %s: %s", session_name, e)


def _get_shell_command(session_name: str | None = None) -> list[str]:
    """Return the command to spawn in the PTY."""
    if _ZELLIJ:
        if session_name:
            return [_ZELLIJ, "attach", session_name, "--create"]
        return [_ZELLIJ]
    return [_DEFAULT_SHELL, "-l"]


def _set_pty_size(fd: int, rows: int, cols: int) -> None:
    """Resize the PTY to the given dimensions."""
    size = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, size)


def _blocking_read(fd: int, shutdown: asyncio.Event) -> bytes:
    """Blocking read from fd with a short poll to allow shutdown."""
    while not shutdown.is_set():
        rlist, _, _ = select.select([fd], [], [], 0.1)
        if rlist:
            try:
                return os.read(fd, 4096)
            except OSError:
                return b""
    return b""


_SESSION_NAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,64}$")
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*m")


# ---------------------------------------------------------------------------
# REST endpoints for session management
# ---------------------------------------------------------------------------

class SessionCreateRequest(BaseModel):
    name: str


@router.get("/sessions")
async def list_sessions():
    """List all zellij sessions."""
    sessions = _list_zellij_sessions()
    return {"sessions": sessions, "zellij_available": bool(_ZELLIJ)}


@router.post("/sessions")
async def create_session(req: SessionCreateRequest):
    """Create a new zellij session (detached)."""
    if not _ZELLIJ:
        return {"error": "zellij is not available"}
    name = req.name.strip()
    if not _SESSION_NAME_RE.match(name):
        return {"error": "Invalid session name. Use alphanumeric, hyphens, underscores only (max 64 chars)."}

    # Check if already exists
    existing = {s["name"] for s in _list_zellij_sessions()}
    if name in existing:
        return {"error": f"Session '{name}' already exists", "name": name}

    # Create session in detached mode via a temp PTY that exits immediately
    try:
        # Use zellij's setup to just create it — we attach later via WebSocket
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        # We start and immediately detach by sending exit
        subprocess.Popen(
            [_ZELLIJ, "attach", name, "--create"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            start_new_session=True,
        )
        # Give it a moment to register
        await asyncio.sleep(0.5)
        return {"ok": True, "name": name}
    except Exception as e:
        return {"error": str(e)}


@router.delete("/sessions/{name}")
async def delete_session(name: str):
    """Kill a zellij session."""
    if not _ZELLIJ:
        return {"error": "zellij is not available"}
    if _attached_sessions.get(name):
        return {"error": f"Session '{name}' is currently attached. Disconnect first."}
    _kill_zellij_session(name)
    return {"ok": True, "name": name}


# ---------------------------------------------------------------------------
# WebSocket terminal
# ---------------------------------------------------------------------------

@router.websocket("/ws")
async def terminal_ws(
    ws: WebSocket,
    session: str = Query(default=""),
):
    """WebSocket endpoint for a web terminal session.

    Query params:
    - session: optional session name to attach/create. If empty, uses plain shell.

    Protocol:
    - Client -> Server text messages: terminal input (keystrokes)
    - Client -> Server JSON messages starting with '\\x01': control messages
      e.g. '\\x01{"type":"resize","rows":24,"cols":80}'
    - Server -> Client binary messages: terminal output
    """
    await ws.accept()

    session_name = session.strip() if session else None

    # If zellij is available but no session name given, refuse — frontend should pick one
    # Actually, allow it for backwards compatibility; just create an anonymous session
    if _ZELLIJ and not session_name:
        import uuid
        session_name = f"web-{uuid.uuid4().hex[:8]}"

    # Check for double-attach
    if session_name and _attached_sessions.get(session_name):
        await ws.send_bytes(
            b"\x1b[31m[Error] Session is already attached in another tab.\x1b[0m\r\n"
        )
        await ws.close()
        return

    # Create PTY
    master_fd, slave_fd = pty.openpty()
    cmd = _get_shell_command(session_name)

    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"

    pid = os.fork()
    if pid == 0:
        # Child process — becomes the shell
        os.close(master_fd)
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)
        os.execvpe(cmd[0], cmd, env)
        os._exit(1)

    # Parent process
    os.close(slave_fd)
    logger.info("Terminal session started: pid=%d, cmd=%s, session=%s", pid, cmd, session_name or "n/a")

    if session_name:
        _attached_sessions[session_name] = True

    # Set master fd to non-blocking
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    loop = asyncio.get_event_loop()
    shutdown = asyncio.Event()

    async def _read_pty():
        """Read output from PTY and send to WebSocket."""
        try:
            while not shutdown.is_set():
                try:
                    data = await loop.run_in_executor(None, _blocking_read, master_fd, shutdown)
                    if data:
                        await ws.send_bytes(data)
                except OSError:
                    break
        except (WebSocketDisconnect, Exception):
            pass

    async def _write_pty():
        """Read input from WebSocket and write to PTY."""
        try:
            while not shutdown.is_set():
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break

                raw = msg.get("text") or msg.get("bytes")
                if not raw:
                    continue

                text = raw if isinstance(raw, str) else raw.decode("utf-8", errors="replace")

                # Control message (resize, etc.)
                if text.startswith("\x01"):
                    try:
                        ctrl = json.loads(text[1:])
                        if ctrl.get("type") == "resize":
                            rows = int(ctrl.get("rows", 24))
                            cols = int(ctrl.get("cols", 80))
                            _set_pty_size(master_fd, rows, cols)
                    except Exception:
                        pass
                    continue

                # Regular terminal input
                data = text.encode("utf-8") if isinstance(text, str) else text
                os.write(master_fd, data)
        except (WebSocketDisconnect, Exception):
            pass

    try:
        await asyncio.gather(_read_pty(), _write_pty())
    finally:
        shutdown.set()
        # Clean up the PTY child process — but do NOT kill the zellij session.
        # The session persists so the user can reattach later.
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        # Mark session as detached (but keep it alive)
        if session_name:
            _attached_sessions.pop(session_name, None)
        logger.info("Terminal session detached: pid=%d, session=%s", pid, session_name or "n/a")


@router.post("/cleanup")
def cleanup_web_terminal_sessions():
    """Kill all web-terminal-* zellij sessions (leftover from disconnected browsers)."""
    if not _ZELLIJ:
        return {"cleaned": 0, "detail": "zellij not available"}

    try:
        result = subprocess.run(
            [_ZELLIJ, "list-sessions"],
            capture_output=True, text=True, timeout=5,
        )
        sessions = result.stdout.strip().splitlines()
    except Exception as e:
        return {"cleaned": 0, "error": str(e)}

    cleaned = 0
    for line in sessions:
        # Format: "session-name [Created ...]" — extract name
        name = line.split()[0].strip() if line.strip() else ""
        if name.startswith("web-terminal-"):
            _kill_zellij_session(name)
            cleaned += 1

    return {"cleaned": cleaned}
