"""Anthropic provider adapter."""
import time
from typing import TYPE_CHECKING

from backend.app.services.adapters.base import ProviderAdapter, AdapterResponse
from backend.app.services.tool_normalizer import translate_tools_for_anthropic

if TYPE_CHECKING:
    from sqlalchemy.orm import Session
    from backend.app.models import ProviderEndpoint


class AnthropicAdapter(ProviderAdapter):
    """Adapter for the Anthropic Messages API."""

    DEFAULT_BASE_URL = "https://api.anthropic.com"

    async def build_headers(self, provider: "ProviderEndpoint", db: "Session") -> dict[str, str]:
        from backend.app.core.runtime_settings import get_anthropic_api_key
        api_key = (provider.api_key or "").strip() or get_anthropic_api_key()
        return {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

    def build_request_body(self, body: dict, model_override: str | None = None) -> dict:
        """Convert OpenAI-format chat body to Anthropic messages format."""
        from backend.app.api.routers.openai_router import _convert_openai_messages_to_anthropic

        messages = body.get("messages") or []
        system_prompt, converted = _convert_openai_messages_to_anthropic(messages)

        model = model_override or body.get("model", "")
        payload: dict = {
            "model": model,
            "messages": converted,
            "max_tokens": int(body.get("max_tokens") or 1024),
            "temperature": body.get("temperature", 0.7),
        }
        if system_prompt:
            payload["system"] = system_prompt

        tools = body.get("tools")
        if tools:
            payload["tools"] = translate_tools_for_anthropic(tools)

        return payload

    def parse_response(self, raw: dict, model_name: str) -> dict:
        """Convert Anthropic response to OpenAI chat completion format."""
        content_items = raw.get("content", [])
        text_chunks = [
            item.get("text", "")
            for item in content_items
            if isinstance(item, dict) and item.get("type") == "text"
        ]
        usage = raw.get("usage") or {}
        prompt_tokens = int(usage.get("input_tokens", 0) or 0)
        completion_tokens = int(usage.get("output_tokens", 0) or 0)

        return {
            "id": raw.get("id", f"chatcmpl-anthropic-{int(time.time())}"),
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model_name,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "".join(text_chunks)},
                    "finish_reason": raw.get("stop_reason") or "stop",
                }
            ],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
        }

    def translate_tools(self, tools: list[dict]) -> list[dict]:
        return translate_tools_for_anthropic(tools)

    def get_chat_url(self, base_url: str) -> str:
        base = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        return f"{base}/v1/messages"
