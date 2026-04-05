"""OpenAI-compatible provider adapter (pass-through)."""
from typing import TYPE_CHECKING

from backend.app.services.adapters.base import ProviderAdapter, AdapterResponse
from backend.app.core.provider_helpers import build_provider_headers, build_provider_chat_url

if TYPE_CHECKING:
    from sqlalchemy.orm import Session
    from backend.app.models import ProviderEndpoint


class OpenAIAdapter(ProviderAdapter):
    """Adapter for OpenAI-compatible providers (no translation needed)."""

    async def build_headers(self, provider: "ProviderEndpoint", db: "Session") -> dict[str, str]:
        return build_provider_headers(provider.api_key or "", provider.extra_headers or "")

    def build_request_body(self, body: dict, model_override: str | None = None) -> dict:
        if model_override:
            return {**body, "model": model_override}
        return body

    def parse_response(self, raw: dict, model_name: str) -> dict:
        # Already in OpenAI format
        return raw

    def get_chat_url(self, base_url: str) -> str:
        return build_provider_chat_url(base_url)
