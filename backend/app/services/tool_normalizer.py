"""Tool/function-calling normalisation layer.

Responsibilities
----------------
1. **Schema translation** — accept OpenAI-style ``tools`` from clients and
   translate to the format expected by each target provider type.
2. **Argument validation** — after the model returns tool-call arguments,
   validate them against the original JSON schema and optionally retry once.
3. **Loop safety** — track the number of tool-call iterations per request
   and stop when the configurable limit is reached.

Provider format map
-------------------
| Provider type       | Format           |
|---------------------|-----------------|
| openai_compatible   | unchanged        |
| anthropic           | Anthropic native |
| local_process/mesh  | unchanged (OpenAI-compat llama.cpp grammar) |
"""
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Configurable limits
MAX_TOOL_ITERATIONS = 10      # stop tool-call loop after this many rounds
TOOL_CALL_TIMEOUT_S = 30.0    # seconds; used by the caller when forwarding

# ---------------------------------------------------------------------------
# OpenAI → Anthropic tool schema translation
# ---------------------------------------------------------------------------

def translate_tools_for_anthropic(openai_tools: list[dict]) -> list[dict]:
    """Convert OpenAI tools array to Anthropic tool_use array.

    OpenAI format:
    ```json
    {"type": "function", "function": {"name": ..., "description": ..., "parameters": {...}}}
    ```

    Anthropic format:
    ```json
    {"name": ..., "description": ..., "input_schema": {...}}
    ```
    """
    anthropic_tools: list[dict] = []
    for tool in openai_tools:
        if tool.get("type") != "function":
            continue
        func = tool.get("function") or {}
        anthropic_tools.append({
            "name": func.get("name", ""),
            "description": func.get("description", ""),
            "input_schema": func.get("parameters") or {"type": "object", "properties": {}},
        })
    return anthropic_tools


def translate_tools_for_openai_compat(openai_tools: list[dict]) -> list[dict]:
    """Pass-through: OpenAI-compat providers already speak the same format."""
    return openai_tools


def translate_tools(body: dict, provider_type: str) -> dict:
    """Return a copy of ``body`` with tools translated for the given provider type.

    If the body has no ``tools`` key this is a no-op.
    """
    tools = body.get("tools")
    if not tools:
        return body

    if provider_type == "anthropic":
        translated = translate_tools_for_anthropic(tools)
        # Anthropic uses top-level "tools" key (same name, different structure)
        return {**body, "tools": translated}

    # openai_compatible / local_process / mesh — no translation needed
    return body


# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------

def _validate_json_schema(instance: Any, schema: dict) -> list[str]:
    """Minimal JSON Schema validation without external deps.

    Returns a list of error messages; empty list means valid.
    Only validates ``required`` properties and basic ``type`` checks.
    Full jsonschema validation is a stretch goal; this catches the most
    common model mistakes (missing required args, wrong primitive type).
    """
    errors: list[str] = []
    if not isinstance(schema, dict):
        return errors

    schema_type = schema.get("type")
    if schema_type == "object":
        if not isinstance(instance, dict):
            errors.append(f"Expected object, got {type(instance).__name__}")
            return errors
        required = schema.get("required") or []
        props = schema.get("properties") or {}
        for req in required:
            if req not in instance:
                errors.append(f"Missing required property: '{req}'")
        for key, value in instance.items():
            if key in props:
                prop_schema = props[key]
                prop_type = prop_schema.get("type")
                if prop_type == "string" and not isinstance(value, str):
                    errors.append(f"Property '{key}': expected string, got {type(value).__name__}")
                elif prop_type == "integer" and not isinstance(value, int):
                    errors.append(f"Property '{key}': expected integer, got {type(value).__name__}")
                elif prop_type == "number" and not isinstance(value, (int, float)):
                    errors.append(f"Property '{key}': expected number, got {type(value).__name__}")
                elif prop_type == "boolean" and not isinstance(value, bool):
                    errors.append(f"Property '{key}': expected boolean, got {type(value).__name__}")
                elif prop_type == "array" and not isinstance(value, list):
                    errors.append(f"Property '{key}': expected array, got {type(value).__name__}")

    return errors


def validate_tool_call_arguments(
    tool_call: dict,
    tools_schema: list[dict],
) -> list[str]:
    """Validate a model's tool-call arguments against the original schema.

    ``tool_call`` is an OpenAI-format tool_call object:
    ```json
    {"id": "...", "type": "function", "function": {"name": "...", "arguments": "..."}}
    ```

    Returns a list of validation error strings; empty = valid.
    """
    func = tool_call.get("function") or {}
    name = func.get("name", "")
    arg_str = func.get("arguments", "{}")

    # Parse arguments JSON
    try:
        args = json.loads(arg_str) if isinstance(arg_str, str) else arg_str
    except json.JSONDecodeError as e:
        return [f"Invalid JSON in arguments for '{name}': {e}"]

    # Find matching schema
    target_schema: dict | None = None
    for tool in tools_schema:
        if tool.get("type") == "function":
            f = tool.get("function") or {}
            if f.get("name") == name:
                target_schema = f.get("parameters") or {}
                break
    if target_schema is None:
        return [f"No schema found for tool '{name}'"]

    return _validate_json_schema(args, target_schema)


def build_tool_validation_retry_message(tool_call: dict, errors: list[str]) -> dict:
    """Build a corrective user message to inject before retrying.

    Returns an OpenAI-format message dict.
    """
    func_name = (tool_call.get("function") or {}).get("name", "unknown")
    error_summary = "; ".join(errors)
    return {
        "role": "user",
        "content": (
            f"Your previous call to '{func_name}' had invalid arguments: {error_summary}. "
            "Please correct the arguments and call the tool again with valid values."
        ),
    }


# ---------------------------------------------------------------------------
# Loop safety counter
# ---------------------------------------------------------------------------

class ToolLoopGuard:
    """Track tool-call iterations for a single request.

    Usage::

        guard = ToolLoopGuard()
        while True:
            ...
            if guard.should_stop():
                break   # enforces MAX_TOOL_ITERATIONS
            guard.increment()
    """

    def __init__(self, max_iterations: int = MAX_TOOL_ITERATIONS):
        self.max_iterations = max_iterations
        self._count = 0

    def increment(self) -> None:
        self._count += 1

    def should_stop(self) -> bool:
        return self._count >= self.max_iterations

    @property
    def count(self) -> int:
        return self._count


def extract_tool_calls_from_response(response_body: dict) -> list[dict]:
    """Extract tool_calls list from an OpenAI chat completion response body.

    Returns an empty list if the response is not a tool call.
    """
    choices = response_body.get("choices") or []
    if not choices:
        return []
    message = choices[0].get("message") or {}
    return message.get("tool_calls") or []
