"""Capability-aware backend selection for the OpenAI-compatible router.

`resolve_candidates()` returns a scored, ordered list of `BackendCandidate`
objects.  The caller tries them in order and falls back on failure.

Selection pipeline
------------------
1. Collect all available backends:  local processes, mesh workers, provider routes
2. Filter by capability requirements parsed from the request body
3. Score by the active route policy (local_first / fastest / cheapest / …)
4. Sort descending by score; return the list

The caller is responsible for building final request headers (e.g. OAuth
token refresh) — this module only determines *which* backend to use and
provides a base URL + static headers.
"""
import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Policy constants  (mirrors schemas.RoutePolicy)
# ---------------------------------------------------------------------------
POLICY_LOCAL_FIRST = "local_first"
POLICY_CHEAPEST = "cheapest"
POLICY_FASTEST = "fastest"
POLICY_HIGHEST_QUALITY = "highest_quality"
POLICY_LOCAL_ONLY = "local_only"
POLICY_REMOTE_ONLY = "remote_only"

DEFAULT_POLICY = POLICY_LOCAL_FIRST

# Provider cost tier — higher number = more expensive (used for CHEAPEST policy)
_PROVIDER_COST_TIER: dict[str, int] = {
    "local_process": 0,
    "mesh_worker": 1,
    "openai_compatible": 2,
    "anthropic": 3,
}


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------
@dataclass
class BackendCandidate:
    """A resolved backend that the router can proxy a request to."""
    backend_type: str       # "local" | "mesh" | "provider"
    display_name: str
    target_url: str
    headers: dict[str, str] = field(default_factory=dict)
    model_override: str | None = None   # If set, replace model in request body
    supports_tools: bool = False
    supports_vision: bool = False
    supports_embeddings: bool = False
    max_context_length: int | None = None
    current_load: float = 0.0
    # Benchmark-derived tokens/sec for the resolved model (None = unknown)
    tg_tokens_per_second: float | None = None
    score: float = 0.0
    # Original ORM objects for callers that need further attributes
    provider: object = None   # ProviderEndpoint | None
    worker: object = None     # MeshWorker | None


@dataclass
class RequestCapabilities:
    """Capability requirements inferred from the incoming request body."""
    needs_tools: bool = False
    needs_vision: bool = False
    needs_embeddings: bool = False
    estimated_context: int = 0     # rough prompt length in tokens


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _parse_capabilities(body: dict) -> RequestCapabilities:
    """Infer capability requirements from an OpenAI-format request body."""
    caps = RequestCapabilities()

    if body.get("tools") or body.get("functions"):
        caps.needs_tools = True

    messages = body.get("messages") or []
    for msg in messages:
        content = msg.get("content") or ""
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") in {"image_url", "image"}:
                    caps.needs_vision = True
                    break
        # Rough token estimate: 1 word ≈ 1.3 tokens
        if isinstance(content, str):
            caps.estimated_context += int(len(content.split()) * 1.3)

    return caps


def _score_candidate(c: BackendCandidate, policy: str) -> float:
    """Return a numeric score; higher is better for the given policy."""
    if policy == POLICY_LOCAL_FIRST:
        base = 100.0 if c.backend_type == "local" else (50.0 if c.backend_type == "mesh" else 10.0)
        # Prefer less loaded workers within the same tier
        return base - c.current_load * 10

    if policy == POLICY_LOCAL_ONLY:
        return 100.0 if c.backend_type == "local" else -1.0

    if policy == POLICY_REMOTE_ONLY:
        return -1.0 if c.backend_type == "local" else 100.0 - c.current_load * 5

    if policy == POLICY_FASTEST:
        if c.tg_tokens_per_second and c.tg_tokens_per_second > 0:
            return c.tg_tokens_per_second
        # No benchmark data: prefer local (usually fastest on same hardware)
        return 50.0 if c.backend_type == "local" else 20.0

    if policy == POLICY_CHEAPEST:
        provider_type = "local_process" if c.backend_type == "local" else (
            "mesh_worker" if c.backend_type == "mesh" else
            (getattr(c.provider, "provider_type", "openai_compatible") if c.provider else "openai_compatible")
        )
        cost_tier = _PROVIDER_COST_TIER.get(provider_type, 2)
        return 100.0 - cost_tier * 20

    if policy == POLICY_HIGHEST_QUALITY:
        # Remote cloud providers assumed higher quality; local last
        if c.backend_type == "local":
            return 10.0
        provider_type = getattr(c.provider, "provider_type", "openai_compatible") if c.provider else "openai_compatible"
        if provider_type == "anthropic":
            return 90.0
        return 60.0

    # Unknown policy — treat as local_first
    return 100.0 if c.backend_type == "local" else 50.0


# ---------------------------------------------------------------------------
# Main resolution function
# ---------------------------------------------------------------------------
def resolve_candidates(
    db: "Session",
    model_name: str,
    body: dict,
    policy: str = DEFAULT_POLICY,
) -> list[BackendCandidate]:
    """Return a scored, ordered list of backends that can serve the request.

    The list may be empty if no capable backend is found.
    Callers should try candidates in order and fall back on failure.
    """
    from backend.app.models import MeshWorker, ProviderEndpoint, ModelRoute, BenchmarkRecord
    from backend.app.core.process_manager import llama_process_manager

    caps = _parse_capabilities(body)
    candidates: list[BackendCandidate] = []

    # ------------------------------------------------------------------
    # 1. Local llama-server processes
    # ------------------------------------------------------------------
    if policy != POLICY_REMOTE_ONLY:
        port = llama_process_manager.get_router_port_for_model(model_name)
        if port is not None:
            # Look up benchmark data for scoring
            tg_tps = None
            bench = (
                db.query(BenchmarkRecord)
                .filter(BenchmarkRecord.model_name == model_name)
                .order_by(BenchmarkRecord.created_at.desc())
                .first()
            )
            if bench:
                tg_tps = bench.tg_tokens_per_second

            c = BackendCandidate(
                backend_type="local",
                display_name=f"local:{model_name}",
                target_url=f"http://127.0.0.1:{port}/v1/chat/completions",
                headers={"Content-Type": "application/json"},
                supports_tools=True,   # llama.cpp supports tools
                supports_vision=False,  # conservative default
                tg_tokens_per_second=tg_tps,
            )
            candidates.append(c)

    # ------------------------------------------------------------------
    # 2. Mesh worker processes that advertise the model
    # ------------------------------------------------------------------
    if policy != POLICY_LOCAL_ONLY:
        workers = (
            db.query(MeshWorker)
            .filter(MeshWorker.status == "online")
            .order_by(MeshWorker.current_load.asc())
            .all()
        )
        for worker in workers:
            try:
                worker_models = json.loads(worker.models_json or "[]")
            except Exception:
                worker_models = []

            if model_name not in worker_models:
                continue

            # Capability gate
            if caps.needs_tools and not worker.supports_tools:
                logger.debug("[RouteResolver] Skipping mesh worker %s: no tool support", worker.node_name)
                continue
            if caps.needs_vision and not worker.supports_vision:
                logger.debug("[RouteResolver] Skipping mesh worker %s: no vision support", worker.node_name)
                continue
            if caps.estimated_context and worker.max_context_length:
                if caps.estimated_context > worker.max_context_length:
                    logger.debug(
                        "[RouteResolver] Skipping mesh worker %s: context %d > max %d",
                        worker.node_name, caps.estimated_context, worker.max_context_length,
                    )
                    continue

            headers: dict[str, str] = {"Content-Type": "application/json"}
            if worker.api_token:
                headers["Authorization"] = f"Bearer {worker.api_token}"

            c = BackendCandidate(
                backend_type="mesh",
                display_name=f"mesh:{worker.node_name}",
                target_url=worker.base_url.rstrip("/") + "/v1/chat/completions",
                headers=headers,
                supports_tools=bool(worker.supports_tools),
                supports_vision=bool(worker.supports_vision),
                supports_embeddings=bool(worker.supports_embeddings),
                max_context_length=worker.max_context_length,
                current_load=worker.current_load or 0.0,
                worker=worker,
            )
            candidates.append(c)

    # ------------------------------------------------------------------
    # 3. Explicit model route table → provider endpoints
    # ------------------------------------------------------------------
    if policy != POLICY_LOCAL_ONLY:
        rules = (
            db.query(ModelRoute)
            .filter(ModelRoute.enabled == 1)
            .order_by(ModelRoute.priority.asc())
            .all()
        )
        for rule in rules:
            matched = False
            if rule.match_type == "exact" and model_name == rule.match_value:
                matched = True
            elif rule.match_type == "prefix" and model_name.startswith(rule.match_value):
                matched = True
            if not matched:
                continue

            provider = (
                db.query(ProviderEndpoint)
                .filter(ProviderEndpoint.id == rule.provider_id, ProviderEndpoint.enabled == 1)
                .first()
            )
            if not provider:
                continue

            routed_model = rule.target_model or model_name
            if not rule.target_model and rule.match_type == "prefix" and model_name.startswith(rule.match_value):
                routed_model = model_name[len(rule.match_value):]

            c = BackendCandidate(
                backend_type="provider",
                display_name=f"provider:{provider.name}",
                target_url="",   # caller builds this per provider_type
                headers={},      # caller builds with token refresh if needed
                model_override=routed_model if routed_model != model_name else None,
                supports_tools=(provider.provider_type in {"openai_compatible", "anthropic"}),
                supports_vision=(provider.provider_type in {"openai_compatible", "anthropic"}),
                provider=provider,
            )
            candidates.append(c)

    # ------------------------------------------------------------------
    # Score and sort
    # ------------------------------------------------------------------
    for c in candidates:
        c.score = _score_candidate(c, policy)

    # Remove explicitly excluded tiers (negative score = excluded)
    candidates = [c for c in candidates if c.score >= 0]
    candidates.sort(key=lambda c: c.score, reverse=True)

    if candidates:
        logger.debug(
            "[RouteResolver] %d candidates for '%s' (policy=%s): %s",
            len(candidates),
            model_name,
            policy,
            [f"{c.display_name}({c.score:.0f})" for c in candidates],
        )
    else:
        logger.debug("[RouteResolver] No candidates for '%s' (policy=%s)", model_name, policy)

    return candidates
