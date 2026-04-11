"""Config Export API — generate provider config files for external tools.

Currently supports:
  - pi agent  (~/.pi/agent/models.json)

Output formats: JSON, YAML
"""
import json
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import ProviderEndpoint, ModelRoute

router = APIRouter(prefix="/api/config-export", tags=["config-export"])


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------
class ExportTarget(BaseModel):
    key: str
    label: str
    description: str
    formats: list[str]
    default_path: str


class ExportResult(BaseModel):
    target: str
    format: str
    mode: str          # "full" | "patch"
    content: str       # full merged output (what the file will look like after write)
    patch_entry: str   # just the new entry being patched in (patch mode only)
    model_count: int
    provider_count: int


class WriteResult(BaseModel):
    ok: bool
    path: str
    message: str


class WriteRequest(BaseModel):
    target: str = "pi-agent"
    format: str = "json"
    path: str = ""           # empty = use default
    mode: str = "full"       # "full" | "patch"
    provider_key: str = "llm-router"           # patch mode: which key to update
    router_base_url: str = "http://localhost:8000/v1"  # patch mode: router endpoint


# ---------------------------------------------------------------------------
# Helpers — build pi-agent models.json from DB state
# ---------------------------------------------------------------------------
def _sanitize_provider_name(name: str) -> str:
    """Convert provider DB name to a safe key for models.json."""
    import re
    # Strip parenthesized email/account suffixes like "(user@email.com)"
    cleaned = re.sub(r"\s*\([^)]*@[^)]*\)", "", name)
    return (
        cleaned.strip()
        .lower()
        .replace(" ", "-")
        .replace("(", "")
        .replace(")", "")
        .replace("_", "-")
    )


def _unique_provider_key(base_key: str, existing_keys: set[str]) -> str:
    """Ensure the provider key is unique by appending a numeric suffix if needed."""
    if base_key not in existing_keys:
        return base_key
    i = 2
    while f"{base_key}-{i}" in existing_keys:
        i += 1
    return f"{base_key}-{i}"


def _detect_api_type(provider: ProviderEndpoint) -> str:
    """Infer the pi agent API type from the provider_type field."""
    if provider.provider_type == "anthropic":
        return "anthropic-messages"
    return "openai-completions"


def _detect_input_types(route: ModelRoute) -> list[str]:
    """Determine input modalities from route capabilities."""
    inputs = ["text"]
    if route.supports_vision:
        inputs.append("image")
    return inputs


# ---------------------------------------------------------------------------
# Patch mode — generate a single "llm-router" provider entry
# ---------------------------------------------------------------------------
def _build_llm_router_entry(db: Session, base_url: str = "http://localhost:8000/v1") -> dict:
    """Build a single provider entry pointing at the LLM Router itself.

    In patch mode we want pi agent to talk *to this router* as one provider,
    and let the router handle upstream dispatch.  Every enabled model route
    becomes a model the client can request by its match_value.
    """
    routes = (
        db.query(ModelRoute)
        .filter(ModelRoute.enabled == 1)
        .order_by(ModelRoute.priority.asc())
        .all()
    )

    models_list = []
    seen_ids: set[str] = set()
    for route in routes:
        model_id = route.route_name  # Use the user-facing alias (not match_value).
                                     # The route_resolver already matches by route_name,
                                     # so pi agent can send this directly to the router.
        if model_id in seen_ids:
            continue
        seen_ids.add(model_id)

        model_entry: dict = {"id": model_id}
        # No separate "name" field needed — id IS the display name.
        model_entry["reasoning"] = bool(route.supports_thinking)
        model_entry["input"] = _detect_input_types(route)
        model_entry["contextWindow"] = (
            route.context_length
            if route.context_length and route.context_length > 0
            else 128000
        )
        model_entry["maxTokens"] = 32768
        model_entry["cost"] = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        models_list.append(model_entry)

    return {
        "baseUrl": base_url.rstrip("/"),
        "api": "openai-completions",
        "apiKey": "local",
        "compat": {
            "supportsDeveloperRole": False,
            "supportsReasoningEffort": False,
        },
        "models": models_list,
    }


def _merge_patch(existing_content: str, provider_key: str, new_entry: dict) -> dict:
    """Merge one provider entry into an existing models.json dict.

    Reads existing JSON, replaces only `providers[provider_key]`,
    and returns the full merged structure.  All other keys are untouched.
    """
    try:
        existing = json.loads(existing_content) if existing_content.strip() else {}
    except (json.JSONDecodeError, TypeError):
        existing = {}
    if not isinstance(existing, dict):
        existing = {}
    if "providers" not in existing or not isinstance(existing.get("providers"), dict):
        existing["providers"] = {}
    existing["providers"][provider_key] = new_entry
    return existing


def _build_local_process_entry(provider: ProviderEndpoint, routes: list[ModelRoute]) -> dict:
    """Build a direct pi-agent entry for a local_process provider.

    Uses target_model as the model id so pi agent calls the model by its real
    name on that local server, not by the router alias.
    """
    base_url = (provider.base_url or "").rstrip("/")
    models_list: list[dict] = []
    seen: set[str] = set()
    for route in routes:
        model_id = route.target_model or route.match_value
        if model_id in seen:
            continue
        seen.add(model_id)
        entry: dict = {"id": model_id}
        if route.route_name and route.route_name != model_id:
            entry["name"] = route.route_name
        entry["reasoning"] = bool(route.supports_thinking)
        entry["input"] = _detect_input_types(route)
        entry["contextWindow"] = (
            route.context_length if route.context_length and route.context_length > 0 else 128000
        )
        entry["maxTokens"] = 32768
        entry["cost"] = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        models_list.append(entry)

    return {
        "baseUrl": base_url,
        "api": "openai-completions",
        "apiKey": "local",
        "compat": {
            "supportsDeveloperRole": False,
            "supportsReasoningEffort": False,
        },
        "models": models_list,
    }


def _build_pi_agent_config(
    db: Session,
    router_base_url: str = "http://localhost:8000/v1",
) -> dict:
    """Build a focused pi-agent models.json with only:

    1. One ``llm-router`` entry — all enabled ModelRoutes as models (client
       sends match_value; router handles upstream dispatch).
    2. One entry per enabled ``local_process`` provider — direct access to
       local llama-server instances, using target_model as model id.

    Remote upstream providers (GitHub Copilot, Google, OpenRouter, etc.) are
    intentionally excluded; pi agent routes through the LLM Router instead.
    """
    # 1. llm-router entry: all enabled Routes
    router_entry = _build_llm_router_entry(db, router_base_url)

    # 2. local_process providers
    local_providers = (
        db.query(ProviderEndpoint)
        .filter(
            ProviderEndpoint.enabled == 1,
            ProviderEndpoint.provider_type == "local_process",
        )
        .order_by(ProviderEndpoint.name)
        .all()
    )

    # Index all enabled routes by provider_id (for local providers)
    all_routes = (
        db.query(ModelRoute)
        .filter(ModelRoute.enabled == 1)
        .order_by(ModelRoute.priority.asc())
        .all()
    )
    routes_by_provider: dict[int, list[ModelRoute]] = {}
    for route in all_routes:
        routes_by_provider.setdefault(route.provider_id, []).append(route)

    result_providers: dict[str, dict] = {}

    # Add llm-router only if it has models
    if router_entry.get("models"):
        result_providers["llm-router"] = router_entry

    # Add each local_process provider
    for provider in local_providers:
        provider_routes = routes_by_provider.get(provider.id, [])
        base_key = _sanitize_provider_name(provider.name)
        key = _unique_provider_key(base_key, set(result_providers.keys()))
        result_providers[key] = _build_local_process_entry(provider, provider_routes)

    return {"providers": result_providers}


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------
def _to_json(data: dict) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False)


def _to_yaml(data: dict) -> str:
    """Convert dict to YAML. Uses pyyaml if available, else manual conversion."""
    try:
        import yaml

        return yaml.dump(data, default_flow_style=False, allow_unicode=True, sort_keys=False)
    except ImportError:
        # Fallback: simple manual YAML-like output
        return _dict_to_yaml_fallback(data)


def _dict_to_yaml_fallback(obj, indent: int = 0) -> str:
    """Minimal YAML serializer when pyyaml is not installed."""
    lines: list[str] = []
    prefix = "  " * indent
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (dict, list)):
                lines.append(f"{prefix}{k}:")
                lines.append(_dict_to_yaml_fallback(v, indent + 1))
            else:
                lines.append(f"{prefix}{k}: {_yaml_scalar(v)}")
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, dict):
                first = True
                for k, v in item.items():
                    if first:
                        lines.append(f"{prefix}- {k}: {_yaml_scalar(v) if not isinstance(v, (dict, list)) else ''}")
                        if isinstance(v, (dict, list)):
                            lines.append(_dict_to_yaml_fallback(v, indent + 2))
                        first = False
                    else:
                        lines.append(f"{prefix}  {k}: {_yaml_scalar(v) if not isinstance(v, (dict, list)) else ''}")
                        if isinstance(v, (dict, list)):
                            lines.append(_dict_to_yaml_fallback(v, indent + 2))
            else:
                lines.append(f"{prefix}- {_yaml_scalar(item)}")
    return "\n".join(lines)


def _yaml_scalar(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if any(c in s for c in (":", "#", "'", '"', "\n", "{", "}", "[", "]")):
        return f'"{s}"'
    return s


def _format_config(data: dict, fmt: str) -> str:
    if fmt == "yaml":
        return _to_yaml(data)
    return _to_json(data)


# ---------------------------------------------------------------------------
# Default target paths
# ---------------------------------------------------------------------------
PI_AGENT_DEFAULT_PATH = os.path.expanduser("~/.pi/agent/models.json")


EXPORT_TARGETS: list[ExportTarget] = [
    ExportTarget(
        key="pi-agent",
        label="Pi Agent (models.json)",
        description="Generate ~/.pi/agent/models.json for pi coding agent. "
        "Maps your providers and model routes to pi's custom provider format.",
        formats=["json", "yaml"],
        default_path=PI_AGENT_DEFAULT_PATH,
    ),
]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.get("/targets", response_model=list[ExportTarget])
def list_export_targets():
    """List available config export targets."""
    return EXPORT_TARGETS


@router.get("/preview", response_model=ExportResult)
def preview_config(
    target: str = Query("pi-agent"),
    format: str = Query("json"),
    mode: str = Query("full"),
    provider_key: str = Query("llm-router"),
    router_base_url: str = Query("http://localhost:8000/v1"),
    db: Session = Depends(get_db),
):
    """Preview the generated config without writing to disk.

    mode=full  → generate all providers/routes as a fresh models.json
    mode=patch → generate only the llm-router entry and merge it into the
                 existing file; only `providers[provider_key]` is replaced.
    """
    if target != "pi-agent":
        raise HTTPException(status_code=400, detail=f"Unknown export target: {target}")
    if format not in ("json", "yaml"):
        raise HTTPException(status_code=400, detail=f"Unsupported format: {format}.")
    if mode not in ("full", "patch"):
        raise HTTPException(status_code=400, detail=f"Unknown mode: {mode}. Use 'full' or 'patch'.")

    if mode == "patch":
        # Build only the llm-router entry
        new_entry = _build_llm_router_entry(db, router_base_url)
        patch_entry_content = _format_config(new_entry, format)

        # Merge into existing file (if any)
        path = Path(PI_AGENT_DEFAULT_PATH).expanduser()
        existing_raw = path.read_text(encoding="utf-8") if path.exists() else ""
        merged = _merge_patch(existing_raw, provider_key, new_entry)
        content = _format_config(merged, format)

        provider_count = len(merged.get("providers", {}))
        model_count = len(new_entry.get("models", []))

        return ExportResult(
            target=target,
            format=format,
            mode=mode,
            content=content,
            patch_entry=patch_entry_content,
            model_count=model_count,
            provider_count=provider_count,
        )

    # mode == "full"
    config = _build_pi_agent_config(db, router_base_url)
    content = _format_config(config, format)
    provider_count = len(config.get("providers", {}))
    model_count = sum(
        len(p.get("models", []))
        for p in config.get("providers", {}).values()
    )
    return ExportResult(
        target=target,
        format=format,
        mode=mode,
        content=content,
        patch_entry="",
        model_count=model_count,
        provider_count=provider_count,
    )


@router.post("/write", response_model=WriteResult)
def write_config(
    req: WriteRequest,
    db: Session = Depends(get_db),
):
    """Write the generated config to a file on disk.

    mode=full  → overwrite the entire file with the freshly generated config.
    mode=patch → read existing file, replace only `providers[provider_key]`,
                 write back. All other providers are preserved.
    """
    if req.target != "pi-agent":
        raise HTTPException(status_code=400, detail=f"Unknown export target: {req.target}")
    if req.format not in ("json", "yaml"):
        raise HTTPException(status_code=400, detail=f"Unsupported format: {req.format}")
    if req.mode not in ("full", "patch"):
        raise HTTPException(status_code=400, detail=f"Unknown mode: {req.mode}.")

    target_path = req.path.strip() if req.path.strip() else PI_AGENT_DEFAULT_PATH
    if req.format == "yaml" and target_path.endswith(".json"):
        target_path = target_path.rsplit(".", 1)[0] + ".yaml"
    path = Path(target_path).expanduser()

    if req.mode == "patch":
        new_entry = _build_llm_router_entry(db, req.router_base_url)
        existing_raw = path.read_text(encoding="utf-8") if path.exists() else ""
        merged = _merge_patch(existing_raw, req.provider_key, new_entry)
        content = _format_config(merged, req.format)
    else:
        config = _build_pi_agent_config(db, req.router_base_url)
        content = _format_config(config, req.format)

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    except Exception as e:
        return WriteResult(ok=False, path=str(path), message=f"Write failed: {e}")

    action = "patched" if req.mode == "patch" else "written"
    return WriteResult(
        ok=True,
        path=str(path),
        message=f"Config {action} successfully ({len(content)} bytes)",
    )


@router.get("/current-file")
def read_current_file(
    target: str = Query("pi-agent"),
):
    """Read the current config file from disk (if it exists)."""
    if target != "pi-agent":
        raise HTTPException(status_code=400, detail=f"Unknown target: {target}")

    path = Path(PI_AGENT_DEFAULT_PATH).expanduser()
    if not path.exists():
        return {"exists": False, "path": str(path), "content": ""}

    try:
        content = path.read_text(encoding="utf-8")
        return {"exists": True, "path": str(path), "content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {e}")
