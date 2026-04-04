"""Runtime helpers to read DB-backed settings with env fallback."""
from __future__ import annotations

from backend.app.core.config import settings
from backend.app.database import SessionLocal
from backend.app.models import Setting


def get_setting_value(key: str, default: str = "") -> str:
    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.key == key).first()
        if row and row.value is not None and row.value != "":
            return str(row.value)
    finally:
        db.close()
    return default


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
