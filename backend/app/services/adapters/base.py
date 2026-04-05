"""Base provider adapter interface."""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.orm import Session
    from backend.app.models import ProviderEndpoint


@dataclass
class AdapterResponse:
    """Normalised completion response in OpenAI format."""
    ok: bool
    status_code: int
    body: dict
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ProviderAdapter(ABC):
    """Abstract base for provider-specific request/response handling."""

    @abstractmethod
    async def build_headers(self, provider: "ProviderEndpoint", db: "Session") -> dict[str, str]:
        """Build HTTP headers for the provider (handles auth/token refresh)."""

    @abstractmethod
    def build_request_body(self, body: dict, model_override: str | None = None) -> dict:
        """Translate an OpenAI-format request body to the provider's format."""

    @abstractmethod
    def parse_response(self, raw: dict, model_name: str) -> dict:
        """Convert the provider's response to OpenAI chat completion format."""

    def translate_tools(self, tools: list[dict]) -> list[dict]:
        """Translate OpenAI tools array to provider's tool format (default: pass-through)."""
        return tools

    def get_chat_url(self, base_url: str) -> str:
        """Return the full chat completions URL for this provider."""
        raise NotImplementedError
