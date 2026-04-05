"""Provider adapter abstraction layer.

Each adapter encapsulates the provider-specific logic for building
request headers, translating request/response bodies, and handling
auth token refresh.

Usage (future):
    from backend.app.services.adapters import get_adapter
    adapter = get_adapter(provider)
    headers = await adapter.build_headers(provider, db)
    req_body = adapter.build_request_body(body)
    resp = adapter.parse_response(raw_response, model_name)
"""
from .base import ProviderAdapter, AdapterResponse
from .openai_adapter import OpenAIAdapter
from .anthropic_adapter import AnthropicAdapter

__all__ = ["ProviderAdapter", "AdapterResponse", "OpenAIAdapter", "AnthropicAdapter", "get_adapter"]


def get_adapter(provider_type: str) -> "ProviderAdapter":
    """Return the appropriate adapter for the given provider_type."""
    if provider_type == "anthropic":
        return AnthropicAdapter()
    # openai_compatible / local_process / mesh
    return OpenAIAdapter()
