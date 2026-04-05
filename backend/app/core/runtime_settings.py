"""Runtime helpers to read DB-backed settings and runtime definitions."""
from __future__ import annotations

import json
import logging

from backend.app.core.config import settings
from backend.app.database import SessionLocal
from backend.app.models import Runtime, Setting

logger = logging.getLogger(__name__)


def get_setting_value(key: str, default: str = "") -> str:
    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.key == key).first()
        if row and row.value is not None and row.value != "":
            return str(row.value)
    finally:
        db.close()
    return default


def _parse_runtime_env(environment_vars: str) -> dict[str, str]:
    if not environment_vars:
        return {}

    try:
        parsed = json.loads(environment_vars)
    except json.JSONDecodeError:
        logger.warning("Invalid runtime environment_vars JSON: %s", environment_vars)
        return {}

    if not isinstance(parsed, dict):
        logger.warning("Runtime environment_vars must be a JSON object: %s", environment_vars)
        return {}

    return {
        str(key): str(value)
        for key, value in parsed.items()
        if value is not None and str(key).strip()
    }


def get_llama_rocm_path() -> str:
    return get_setting_value("llama_rocm_path", settings.llama_rocm_path)


def get_llama_vulkan_path() -> str:
    return get_setting_value("llama_vulkan_path", settings.llama_vulkan_path)


def get_hsa_override_gfx_version() -> str:
    return get_setting_value("hsa_override_gfx_version", settings.hsa_override_gfx_version)


def get_openai_api_key() -> str:
    return get_setting_value("openai_api_key", settings.openai_api_key)


def get_anthropic_api_key() -> str:
    return get_setting_value("anthropic_api_key", settings.anthropic_api_key)


def get_github_client_id() -> str:
    return get_setting_value("github_client_id", settings.github_client_id)


def get_github_client_secret() -> str:
    return get_setting_value("github_client_secret", settings.github_client_secret)


def get_google_client_id() -> str:
    return get_setting_value("google_client_id", settings.google_client_id)


def get_google_client_secret() -> str:
    return get_setting_value("google_client_secret", settings.google_client_secret)


def get_runtime_command(runtime_name: str) -> tuple[str, dict[str, str]]:
    normalized_name = runtime_name.strip()
    if not normalized_name:
        raise ValueError("運行時名稱不可為空")

    db = SessionLocal()
    try:
        runtime = db.query(Runtime).filter(Runtime.name == normalized_name).first()
        if runtime:
            return runtime.executable_path.strip(), _parse_runtime_env(runtime.environment_vars)
    finally:
        db.close()

    legacy_name = normalized_name.lower()
    if legacy_name == "rocm":
        return get_llama_rocm_path(), {"HSA_OVERRIDE_GFX_VERSION": get_hsa_override_gfx_version()}
    if legacy_name == "vulkan":
        return get_llama_vulkan_path(), {}

    raise ValueError(f"找不到運行時環境 '{runtime_name}'")


def ensure_default_runtimes() -> None:
    defaults = [
        {
            "name": "rocm",
            "description": "Legacy ROCm runtime",
            "executable_path": get_llama_rocm_path(),
            "environment_vars": json.dumps(
                {"HSA_OVERRIDE_GFX_VERSION": get_hsa_override_gfx_version()},
                ensure_ascii=True,
                separators=(",", ":"),
            ),
        },
        {
            "name": "vulkan",
            "description": "Legacy Vulkan runtime",
            "executable_path": get_llama_vulkan_path(),
            "environment_vars": "{}",
        },
    ]

    db = SessionLocal()
    try:
        existing = {runtime.name: runtime for runtime in db.query(Runtime).all()}
        seed_marker = db.query(Setting).filter(Setting.key == "runtime_objects_seeded").first()
        mutated = False

        if existing and seed_marker is None:
            db.add(Setting(key="runtime_objects_seeded", value="1"))
            mutated = True

        for default in defaults:
            runtime = existing.get(default["name"])
            if runtime is None and not existing and seed_marker is None:
                db.add(Runtime(**default))
                mutated = True
                continue

            if runtime is not None and default["name"] == "rocm" and (runtime.environment_vars or "{}").strip() in {"", "{}"}:
                runtime.environment_vars = default["environment_vars"]
                mutated = True

        if not existing and seed_marker is None:
            db.add(Setting(key="runtime_objects_seeded", value="1"))
            mutated = True

        if mutated:
            db.commit()
    finally:
        db.close()
