"""Background health-check service for registered mesh workers.

Runs as an asyncio task (started in app lifespan).  Every CHECK_INTERVAL seconds
it probes each worker, updates capability fields, and transitions status:

  online  →  stale  (after STALE_THRESHOLD consecutive failures)
  stale   →  offline (after OFFLINE_THRESHOLD consecutive failures)
  offline  →  online  (recovers immediately on success)
"""
import asyncio
import json
import logging
from datetime import datetime, timezone

import httpx

logger = logging.getLogger(__name__)

CHECK_INTERVAL = 30       # seconds between full check cycles
STALE_THRESHOLD = 2       # consecutive failures → stale
OFFLINE_THRESHOLD = 5     # consecutive failures → offline
PROBE_TIMEOUT = 10.0      # seconds per individual worker probe


async def _probe_worker(base_url: str, api_token: str) -> dict | None:
    """Probe a worker's /v1/models endpoint.

    Returns a dict with capability info on success, None on failure.
    """
    url = base_url.rstrip("/") + "/v1/models"
    headers: dict[str, str] = {}
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"

    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            logger.debug("[MeshHealth] %s returned %d", url, resp.status_code)
            return None
        data = resp.json()
    except Exception as exc:
        logger.debug("[MeshHealth] probe failed for %s: %s", base_url, exc)
        return None

    # Parse model list from OpenAI /v1/models response
    models: list[str] = []
    supports_tools = False
    supports_vision = False
    supports_embeddings = False
    max_ctx: int | None = None

    for item in data.get("data", []):
        model_id = item.get("id", "")
        if model_id:
            models.append(model_id)
        # Infer capabilities from model metadata when present
        meta = item.get("metadata") or item.get("capabilities") or {}
        if meta.get("supports_function_calling") or meta.get("tools"):
            supports_tools = True
        if meta.get("supports_vision") or meta.get("vision"):
            supports_vision = True
        if "embed" in model_id.lower() or "embedding" in model_id.lower():
            supports_embeddings = True
        ctx = meta.get("context_length") or meta.get("max_context_length")
        if ctx and (max_ctx is None or int(ctx) > max_ctx):
            max_ctx = int(ctx)

    return {
        "models": models,
        "supports_tools": supports_tools,
        "supports_vision": supports_vision,
        "supports_embeddings": supports_embeddings,
        "max_context_length": max_ctx,
    }


async def run_health_checks() -> None:
    """Continuously probe all registered workers on a fixed interval."""
    # Import here to avoid circular imports at module load time
    from backend.app.database import SessionLocal
    from backend.app.models import MeshWorker

    logger.info("[MeshHealth] Background health-check task started (interval=%ds)", CHECK_INTERVAL)

    while True:
        await asyncio.sleep(CHECK_INTERVAL)

        db = SessionLocal()
        try:
            workers: list[MeshWorker] = db.query(MeshWorker).all()
        except Exception as exc:
            logger.error("[MeshHealth] DB query failed: %s", exc)
            db.close()
            continue

        for worker in workers:
            probe_result = await _probe_worker(worker.base_url, worker.api_token)
            now = datetime.now(timezone.utc)

            if probe_result is not None:
                # Success — reset failure counter, update capabilities
                worker.consecutive_failures = 0
                worker.status = "online"
                worker.last_seen_at = now
                worker.last_health_check_at = now
                worker.models_json = json.dumps(probe_result["models"])
                worker.supports_tools = int(probe_result["supports_tools"])
                worker.supports_vision = int(probe_result["supports_vision"])
                worker.supports_embeddings = int(probe_result["supports_embeddings"])
                if probe_result["max_context_length"] is not None:
                    worker.max_context_length = probe_result["max_context_length"]
                logger.debug(
                    "[MeshHealth] %s OK — %d models, tools=%s vision=%s",
                    worker.node_name,
                    len(probe_result["models"]),
                    probe_result["supports_tools"],
                    probe_result["supports_vision"],
                )
            else:
                # Failure — increment counter, adjust status
                worker.consecutive_failures += 1
                worker.last_health_check_at = now
                if worker.consecutive_failures >= OFFLINE_THRESHOLD:
                    if worker.status != "offline":
                        logger.warning(
                            "[MeshHealth] %s → offline (failures=%d)",
                            worker.node_name, worker.consecutive_failures,
                        )
                    worker.status = "offline"
                elif worker.consecutive_failures >= STALE_THRESHOLD:
                    if worker.status == "online":
                        logger.warning(
                            "[MeshHealth] %s → stale (failures=%d)",
                            worker.node_name, worker.consecutive_failures,
                        )
                    worker.status = "stale"

        try:
            db.commit()
        except Exception as exc:
            logger.error("[MeshHealth] DB commit failed: %s", exc)
            db.rollback()
        finally:
            db.close()
