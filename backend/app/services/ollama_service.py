"""
Ollama service — probes the Ollama HTTP API for status and model management.

Ollama exposes a REST API (default port 11434).
  GET  /api/tags     → list local models
  GET  /api/ps       → list running models
  POST /api/pull     → pull a model
  DELETE /api/delete → delete a model
"""
import logging
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)

DEFAULT_PORT = 11434
DEFAULT_HOST = "127.0.0.1"
PROBE_TIMEOUT = 5.0


@dataclass
class OllamaModel:
    name: str
    size: int = 0
    digest: str = ""
    parameter_size: str = ""
    quantization_level: str = ""


@dataclass
class OllamaRunningModel:
    name: str
    size: int = 0
    vram_size: int = 0
    expires_at: str = ""


@dataclass
class OllamaStatus:
    running: bool = False
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    local_models: list[OllamaModel] = field(default_factory=list)
    running_models: list[OllamaRunningModel] = field(default_factory=list)
    error: str = ""


async def get_status(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> OllamaStatus:
    base = f"http://{host}:{port}"
    status = OllamaStatus(host=host, port=port)
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
            # Check if Ollama is reachable
            resp = await client.get(f"{base}/api/tags")
            if resp.status_code == 200:
                status.running = True
                data = resp.json()
                for m in data.get("models", []):
                    details = m.get("details", {})
                    status.local_models.append(OllamaModel(
                        name=m.get("name", ""),
                        size=m.get("size", 0),
                        digest=m.get("digest", "")[:12],
                        parameter_size=details.get("parameter_size", ""),
                        quantization_level=details.get("quantization_level", ""),
                    ))

            # Get running models
            try:
                ps_resp = await client.get(f"{base}/api/ps")
                if ps_resp.status_code == 200:
                    ps_data = ps_resp.json()
                    for m in ps_data.get("models", []):
                        status.running_models.append(OllamaRunningModel(
                            name=m.get("name", ""),
                            size=m.get("size", 0),
                            vram_size=m.get("size_vram", 0),
                            expires_at=m.get("expires_at", ""),
                        ))
            except Exception:
                pass  # ps endpoint may not be available in older versions

    except httpx.ConnectError:
        status.error = f"Cannot connect to Ollama at {base}"
    except httpx.TimeoutException:
        status.error = f"Timeout connecting to Ollama at {base}"
    except Exception as exc:
        status.error = str(exc)
    return status


async def pull_model(name: str, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> dict:
    base = f"http://{host}:{port}"
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(f"{base}/api/pull", json={"model": name, "stream": False})
            if resp.status_code == 200:
                return {"success": True, "message": f"Pulled {name}", "status": resp.json().get("status", "")}
            return {"success": False, "message": f"Pull failed: {resp.text}"}
    except Exception as exc:
        return {"success": False, "message": str(exc)}


async def delete_model(name: str, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> dict:
    base = f"http://{host}:{port}"
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
            resp = await client.request("DELETE", f"{base}/api/delete", json={"model": name})
            if resp.status_code == 200:
                return {"success": True, "message": f"Deleted {name}"}
            return {"success": False, "message": f"Delete failed: {resp.text}"}
    except Exception as exc:
        return {"success": False, "message": str(exc)}
