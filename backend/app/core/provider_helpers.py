"""Utilities for provider URL and header handling."""
from __future__ import annotations

import json


def build_provider_headers(api_key: str, extra_headers_json: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if extra_headers_json:
        try:
            parsed = json.loads(extra_headers_json)
            if isinstance(parsed, dict):
                headers.update({str(k): str(v) for k, v in parsed.items()})
        except Exception:
            pass
    return headers


def _base_with_default_v1(base_url: str) -> tuple[str, bool]:
    base = (base_url or "").rstrip("/")
    lower = base.lower()
    if lower.endswith("/v1") or lower.endswith("/api/v1") or lower.endswith("/v1beta/openai"):
        return base, True
    return base, False


def build_provider_models_url(base_url: str) -> str:
    base, has_v1 = _base_with_default_v1(base_url)
    if not base:
        return ""
    if has_v1:
        return f"{base}/models"
    return f"{base}/v1/models"


def build_provider_chat_url(base_url: str) -> str:
    base, has_v1 = _base_with_default_v1(base_url)
    if not base:
        return ""
    if has_v1:
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"
