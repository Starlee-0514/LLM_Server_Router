"""Provider router and mesh worker management APIs."""
import hashlib
import json
import os
import secrets
import time
from base64 import urlsafe_b64encode
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import ProviderEndpoint, ModelRoute, MeshWorker
from backend.app.core.provider_helpers import build_provider_headers, build_provider_models_url
from backend.app.core.runtime_settings import (
    get_github_client_id,
    get_github_client_secret,
    get_google_client_id,
    get_google_client_secret,
)
from backend.app.schemas import (
    ProviderEndpointCreate,
    ProviderEndpointResponse,
    ModelRouteCreate,
    ModelRouteResponse,
    MeshWorkerUpsert,
    MeshWorkerResponse,
    CommonProviderTemplate,
    CommonProviderRegisterRequest,
    ProviderModelItem,
)

router = APIRouter(prefix="/api/providers", tags=["providers"])

_oauth_state_store: dict[str, dict] = {}
_device_code_store: dict[str, dict] = {}     # session_id -> device flow state
_pkce_store: dict[str, dict] = {}             # state -> PKCE verifier + metadata


# ---------------------------------------------------------------------------
# PKCE helpers (for Google OAuth)
# ---------------------------------------------------------------------------
def _generate_pkce() -> tuple[str, str]:
    """Generate PKCE code_verifier and code_challenge (S256)."""
    verifier_bytes = os.urandom(32)
    verifier = urlsafe_b64encode(verifier_bytes).rstrip(b"=").decode("ascii")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


# ---------------------------------------------------------------------------
# GitHub Copilot — Token Exchange helpers
# ---------------------------------------------------------------------------
import logging as _logging
_provider_logger = _logging.getLogger(__name__)

async def _exchange_copilot_token(github_access_token: str) -> dict:
    """Exchange a GitHub OAuth access_token for a short-lived Copilot internal token.

    Mirrors pi-mono's `refreshGitHubCopilotToken` — calls the Copilot internal
    token endpoint with the GitHub PAT and returns the Copilot token + expiry.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            "https://api.github.com/copilot_internal/v2/token",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {github_access_token}",
                "User-Agent": "GitHubCopilotChat/0.35.0",
                "Editor-Version": "vscode/1.107.0",
                "Editor-Plugin-Version": "copilot-chat/0.35.0",
                "Copilot-Integration-Id": "vscode-chat",
            },
        )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Copilot token exchange failed ({resp.status_code}): {resp.text[:500]}",
        )
    payload = resp.json()
    token = payload.get("token", "")
    expires_at = payload.get("expires_at", 0)
    if not token:
        raise HTTPException(status_code=502, detail="Copilot token exchange returned empty token")
    return {"token": token, "expires_at": expires_at}


def _is_copilot_provider(provider: ProviderEndpoint) -> bool:
    """Check if a provider is a GitHub Copilot provider by base URL or name."""
    base = (provider.base_url or "").lower()
    name = (provider.name or "").lower()
    return (
        "githubcopilot.com" in base
        or name in ("github_copilot", "github-copilot")
    )


async def _ensure_fresh_copilot_token(provider: ProviderEndpoint, db: Session) -> str:
    """Return a valid Copilot API token, refreshing if expired.

    The provider.api_key stores JSON with github_token, copilot_token, expires_at.
    If the copilot_token is expired, re-exchanges using the github_token.
    """
    api_key = provider.api_key or ""
    if not api_key.startswith("{"):
        return api_key  # plain token, no refresh logic

    try:
        token_data = json.loads(api_key)
    except (json.JSONDecodeError, TypeError):
        return api_key

    github_token = token_data.get("github_token", "")
    copilot_token = token_data.get("copilot_token", "")
    expires_at = token_data.get("expires_at", 0)

    # Refresh 5 minutes before expiry
    if expires_at and time.time() < (expires_at - 300):
        return copilot_token

    if not github_token:
        return copilot_token  # can't refresh without github_token

    # First, try refreshing the github_token itself if we have a refresh_token
    refresh_token = token_data.get("refresh_token", "")
    if refresh_token:
        _provider_logger.info("Refreshing GitHub token (via refresh_token) before Copilot exchange for '%s'", provider.name)
        try:
            new_gh = await _refresh_github_access_token(refresh_token, token_data.get("client_id", get_github_client_id() or ""))
            github_token = new_gh["access_token"]
            token_data["github_token"] = github_token
            if new_gh.get("refresh_token"):
                token_data["refresh_token"] = new_gh["refresh_token"]
        except Exception as e:
            _provider_logger.warning("GitHub token refresh failed for Copilot provider: %s", e)

    _provider_logger.info("Refreshing expired Copilot token for provider '%s'", provider.name)
    try:
        new_data = await _exchange_copilot_token(github_token)
        token_data["copilot_token"] = new_data["token"]
        token_data["expires_at"] = new_data["expires_at"]
        provider.api_key = json.dumps(token_data)
        db.commit()
        return new_data["token"]
    except Exception as e:
        _provider_logger.warning("Copilot token refresh failed: %s", e)
        return copilot_token  # return stale token, let upstream error surface


def _is_github_models_provider(provider: ProviderEndpoint) -> bool:
    """Check if a provider is a GitHub Models provider."""
    name = (provider.name or "").lower()
    return name in ("github_models", "github-models")


async def _refresh_github_access_token(refresh_token: str, client_id: str) -> dict:
    """Refresh an expired GitHub OAuth access_token using a refresh_token."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            data={
                "client_id": client_id,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
        )
    if resp.status_code != 200:
        raise RuntimeError(f"GitHub token refresh HTTP {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    if "access_token" not in data:
        raise RuntimeError(f"GitHub token refresh failed: {data.get('error_description', data.get('error', 'unknown'))}")
    return data


async def _ensure_fresh_github_models_token(provider: ProviderEndpoint, db: Session) -> str:
    """Return a valid API token for GitHub Models.

    GitHub Models now uses the same Copilot token exchange flow,
    so this delegates to _ensure_fresh_copilot_token.
    """
    return await _ensure_fresh_copilot_token(provider, db)


def _get_google_creds() -> tuple[str, str]:
    """Return (client_id, client_secret) for Google OAuth.

    Values come from Settings or the repo-root .env file."""
    return get_google_client_id(), get_google_client_secret()


COMMON_PROVIDER_TEMPLATES: dict[str, dict] = {
    "ollama": {
        "label": "Ollama (local)",
        "provider_type": "openai_compatible",
        "base_url": "http://127.0.0.1:11434/v1",
        "auth_hint": "No API key required — available while Ollama is running",
        "default_extra_headers": "",
        "oauth_method": "none",
    },
    "lm_studio": {
        "label": "LM Studio (local)",
        "provider_type": "openai_compatible",
        "base_url": "http://127.0.0.1:1234",
        "auth_hint": "No API key required — available while LM Studio server is running",
        "default_extra_headers": "",
        "oauth_method": "none",
    },
    "lm_studio_network": {
        "label": "LM Studio (network)",
        "provider_type": "openai_compatible",
        "base_url": "http://192.168.1.x:1234",
        "auth_hint": "Set base_url to your LM Studio host. No API key needed unless you configured one.",
        "default_extra_headers": "",
        "oauth_method": "none",
    },
    "openrouter": {
        "label": "OpenRouter",
        "provider_type": "openai_compatible",
        "base_url": "https://openrouter.ai/api/v1",
        "auth_hint": "Use OpenRouter API Key",
        "default_extra_headers": "",
        "oauth_method": "api_key",
    },
    "github_models": {
        "label": "GitHub Models",
        "provider_type": "openai_compatible",
        "base_url": "https://api.individual.githubcopilot.com",
        "auth_hint": "Uses GitHub OAuth Device Code Flow (Copilot token exchange)",
        "default_extra_headers": json.dumps({
            "Copilot-Integration-Id": "vscode-chat",
            "Editor-Version": "vscode/1.107.0",
            "Editor-Plugin-Version": "copilot-chat/0.35.0",
            "Openai-Intent": "conversation-edits",
        }),
        "oauth_method": "device_code",
    },
    "github_copilot": {
        "label": "GitHub Copilot",
        "provider_type": "openai_compatible",
        "base_url": "https://api.individual.githubcopilot.com",
        "auth_hint": "Uses GitHub OAuth Device Code Flow (requires Copilot subscription)",
        "default_extra_headers": json.dumps({
            "Copilot-Integration-Id": "vscode-chat",
            "Editor-Version": "vscode/1.107.0",
            "Editor-Plugin-Version": "copilot-chat/0.35.0",
            "Openai-Intent": "conversation-edits",
        }),
        "oauth_method": "device_code",
    },
    "google_gemini_openai": {
        "label": "Google Gemini (OpenAI-compatible)",
        "provider_type": "openai_compatible",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "auth_hint": "Uses Google OAuth (PKCE) or API key",
        "default_extra_headers": '{"x-goog-api-key": "<GOOGLE_API_KEY>"}',
        "oauth_method": "pkce",
    },
    "google_gemini_cli": {
        "label": "Google Gemini CLI (Cloud Code Assist)",
        "provider_type": "openai_compatible",
        "base_url": "https://cloudcode-pa.googleapis.com",
        "auth_hint": "Requires Google OAuth client ID and client secret from Settings or .env",
        "default_extra_headers": "",
        "oauth_method": "pkce",
    },
}

# Copilot-specific headers required for GitHub Copilot API requests
COPILOT_STATIC_HEADERS: dict[str, str] = {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Openai-Intent": "conversation-edits",
}


GITHUB_COPILOT_DEFAULT_MODELS: list[dict[str, str]] = [
    {"id": "claude-haiku-4.5", "name": "Claude Haiku 4.5"},
    {"id": "claude-opus-4.5", "name": "Claude Opus 4.5"},
    {"id": "claude-opus-4.6", "name": "Claude Opus 4.6"},
    {"id": "claude-sonnet-4", "name": "Claude Sonnet 4"},
    {"id": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5"},
    {"id": "claude-sonnet-4.6", "name": "Claude Sonnet 4.6"},
    {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro"},
    {"id": "gemini-3-flash-preview", "name": "Gemini 3 Flash Preview"},
    {"id": "gemini-3-pro-preview", "name": "Gemini 3 Pro Preview"},
    {"id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro Preview"},
    {"id": "gpt-4.1", "name": "GPT-4.1"},
    {"id": "gpt-4o", "name": "GPT-4o"},
    {"id": "gpt-5", "name": "GPT-5"},
    {"id": "gpt-5-mini", "name": "GPT-5-mini"},
    {"id": "gpt-5.1", "name": "GPT-5.1"},
    {"id": "gpt-5.1-codex", "name": "GPT-5.1-Codex"},
    {"id": "gpt-5.1-codex-max", "name": "GPT-5.1-Codex-max"},
    {"id": "gpt-5.1-codex-mini", "name": "GPT-5.1-Codex-mini"},
    {"id": "gpt-5.2", "name": "GPT-5.2"},
    {"id": "gpt-5.2-codex", "name": "GPT-5.2-Codex"},
    {"id": "gpt-5.3-codex", "name": "GPT-5.3-Codex"},
    {"id": "gpt-5.4", "name": "GPT-5.4"},
    {"id": "gpt-5.4-mini", "name": "GPT-5.4 mini"},
    {"id": "grok-code-fast-1", "name": "Grok Code Fast 1"},
]


GEMINI_CLI_DEFAULT_MODELS: list[dict[str, str]] = [
    {"id": "gemini-2.0-flash", "name": "Gemini 2.0 Flash (Cloud Code Assist)"},
    {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash (Cloud Code Assist)"},
    {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro (Cloud Code Assist)"},
    {"id": "gemini-3-flash-preview", "name": "Gemini 3 Flash Preview (Cloud Code Assist)"},
    {"id": "gemini-3-pro-preview", "name": "Gemini 3 Pro Preview (Cloud Code Assist)"},
    {"id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro Preview (Cloud Code Assist)"},
]


GITHUB_MODELS_DEFAULT_MODELS: list[dict[str, str]] = [
    {"id": "gpt-4o", "name": "GPT-4o (GitHub Models)"},
    {"id": "gpt-4o-mini", "name": "GPT-4o Mini (GitHub Models)"},
    {"id": "gpt-4.1", "name": "GPT-4.1 (GitHub Models)"},
    {"id": "gpt-4.1-mini", "name": "GPT-4.1 Mini (GitHub Models)"},
    {"id": "gpt-4.1-nano", "name": "GPT-4.1 Nano (GitHub Models)"},
    {"id": "o4-mini", "name": "o4-mini (GitHub Models)"},
    {"id": "o3-mini", "name": "o3-mini (GitHub Models)"},
    {"id": "Meta-Llama-3.1-405B-Instruct", "name": "Llama 3.1 405B (GitHub Models)"},
    {"id": "Meta-Llama-3.1-8B-Instruct", "name": "Llama 3.1 8B (GitHub Models)"},
    {"id": "Phi-4", "name": "Phi-4 (GitHub Models)"},
    {"id": "DeepSeek-R1", "name": "DeepSeek R1 (GitHub Models)"},
]


def _get_default_provider_models(row: ProviderEndpoint) -> list[ProviderModelItem]:
    base_url = (row.base_url or "").rstrip("/").lower()
    provider_name = (row.name or "").strip().lower()

    defaults: list[dict[str, str]] = []
    source = ""
    if "api.individual.githubcopilot.com" in base_url or provider_name in {"github_copilot", "github-copilot"}:
        defaults = GITHUB_COPILOT_DEFAULT_MODELS
        source = "github-copilot"
    elif "models.inference.ai.azure.com" in base_url or provider_name in {"github_models", "github-models"}:
        defaults = GITHUB_MODELS_DEFAULT_MODELS
        source = "github-models"
    elif "cloudcode-pa.googleapis.com" in base_url or provider_name in {"google_gemini_cli", "google-gemini-cli", "gemini-cli"}:
        defaults = GEMINI_CLI_DEFAULT_MODELS
        source = "google-gemini-cli"
    elif "generativelanguage.googleapis.com" in base_url or provider_name in {"google_gemini_openai"}:
        defaults = GEMINI_CLI_DEFAULT_MODELS
        source = "google-gemini-openai"

    return [
        ProviderModelItem(
            id=item["id"],
            provider_name=row.name,
            raw={
                "id": item["id"],
                "name": item["name"],
                "source": "default-fallback",
                "catalog": "pi-mono",
                "provider": source,
            },
        )
        for item in defaults
    ]


@router.get("/common/templates", response_model=list[CommonProviderTemplate])
def list_common_provider_templates():
    return [
        CommonProviderTemplate(
            provider_key=key,
            label=value["label"],
            provider_type=value["provider_type"],
            base_url=value["base_url"],
            auth_hint=value["auth_hint"],
            default_extra_headers=value["default_extra_headers"],
            oauth_method=value.get("oauth_method", "api_key"),
        )
        for key, value in COMMON_PROVIDER_TEMPLATES.items()
    ]


@router.post("/common/register", response_model=ProviderEndpointResponse)
def register_common_provider(request: CommonProviderRegisterRequest, db: Session = Depends(get_db)):
    template = COMMON_PROVIDER_TEMPLATES.get(request.provider_key)
    if not template:
        raise HTTPException(status_code=404, detail=f"Unknown provider template: {request.provider_key}")

    provider_name = request.name_override.strip() or request.provider_key
    existing = db.query(ProviderEndpoint).filter(ProviderEndpoint.name == provider_name).first()

    # Google template prefers x-goog-api-key header and leaves Authorization empty.
    extra_headers = template["default_extra_headers"]
    api_key = request.api_key
    if request.provider_key == "google_gemini_openai" and request.api_key:
        extra_headers = json.dumps({"x-goog-api-key": request.api_key})
        api_key = ""

    if existing:
        existing.provider_type = template["provider_type"]
        existing.base_url = template["base_url"]
        existing.api_key = api_key
        existing.extra_headers = extra_headers
        existing.enabled = 1 if request.enabled else 0
        db.commit()
        db.refresh(existing)
        return existing

    row = ProviderEndpoint(
        name=provider_name,
        provider_type=template["provider_type"],
        base_url=template["base_url"],
        api_key=api_key,
        extra_headers=extra_headers,
        enabled=1 if request.enabled else 0,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ---------------------------------------------------------------------------
# GitHub Models — Device Code Flow  (like pi-mono's github-copilot.ts)
# ---------------------------------------------------------------------------
def _get_github_device_client_id() -> str:
    """Return the GitHub OAuth client_id for device code flow from user configuration."""
    return get_github_client_id() or ""


@router.post("/common/oauth/device/start")
async def start_device_code_flow(request: Request):
    """Start GitHub Device Code Flow. Returns user_code + verification_uri."""
    body = await request.json()
    provider_key = body.get("provider_key", "github_models")
    name_override = body.get("name_override", "")

    if provider_key not in ("github_models", "github_copilot"):
        raise HTTPException(status_code=400, detail="Device code flow only supported for github_models and github_copilot")

    client_id = _get_github_device_client_id()

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://github.com/login/device/code",
            headers={"Accept": "application/json"},
            data={"client_id": client_id, "scope": "read:user"},
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"GitHub device code request failed: {resp.text}")

    data = resp.json()
    device_code = data.get("device_code", "")
    user_code = data.get("user_code", "")
    verification_uri = data.get("verification_uri", "")
    expires_in = data.get("expires_in", 900)
    interval = data.get("interval", 5)

    if not device_code or not user_code:
        raise HTTPException(status_code=502, detail="GitHub did not return device_code/user_code")

    session_id = secrets.token_urlsafe(24)
    _device_code_store[session_id] = {
        "provider_key": provider_key,
        "name_override": name_override.strip(),
        "device_code": device_code,
        "client_id": client_id,
        "interval": interval,
        "expires_at": time.time() + expires_in,
    }

    return {
        "session_id": session_id,
        "user_code": user_code,
        "verification_uri": verification_uri,
        "expires_in": expires_in,
        "interval": interval,
    }


@router.post("/common/oauth/device/poll")
async def poll_device_code_flow(request: Request, db: Session = Depends(get_db)):
    """Poll GitHub for device code authorization status."""
    body = await request.json()
    session_id = body.get("session_id", "")

    ctx = _device_code_store.get(session_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Unknown or expired device flow session")

    if time.time() > ctx["expires_at"]:
        _device_code_store.pop(session_id, None)
        return {"status": "expired"}

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            data={
                "client_id": ctx["client_id"],
                "device_code": ctx["device_code"],
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
        )

    data = resp.json()

    if "access_token" in data:
        _device_code_store.pop(session_id, None)
        access_token = data["access_token"]

        template = COMMON_PROVIDER_TEMPLATES[ctx["provider_key"]]
        provider_name = ctx.get("name_override") or ctx["provider_key"]
        extra_headers = template["default_extra_headers"]

        # Fetch GitHub username for multi-account naming
        if not ctx.get("name_override"):
            try:
                async with httpx.AsyncClient(timeout=10.0) as gh_client:
                    gh_resp = await gh_client.get(
                        "https://api.github.com/user",
                        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
                    )
                    if gh_resp.status_code == 200:
                        gh_user = gh_resp.json().get("login", "")
                        if gh_user:
                            provider_name = f"{template['label']} ({gh_user})"
            except Exception:
                _provider_logger.warning("Failed to fetch GitHub user for account naming")

        # Store token data as JSON including refresh_token for auto-refresh
        refresh_token = data.get("refresh_token", "")
        expires_in = data.get("expires_in", 0)
        token_type = data.get("token_type", "bearer")
        client_id = ctx["client_id"]

        if ctx["provider_key"] == "github_copilot":
            copilot_token_data = await _exchange_copilot_token(access_token)
            # Store as JSON: github_token (for refresh) + copilot_token (for API calls)
            stored_key = json.dumps({
                "github_token": access_token,
                "refresh_token": refresh_token,
                "client_id": client_id,
                "copilot_token": copilot_token_data["token"],
                "expires_at": copilot_token_data["expires_at"],
            })
        elif ctx["provider_key"] == "github_models":
            # Same as Copilot: exchange ghu_ token for Copilot API token
            copilot_token_data = await _exchange_copilot_token(access_token)
            stored_key = json.dumps({
                "github_token": access_token,
                "refresh_token": refresh_token,
                "client_id": client_id,
                "copilot_token": copilot_token_data["token"],
                "expires_at": copilot_token_data["expires_at"],
            })
        else:
            stored_key = access_token

        existing = db.query(ProviderEndpoint).filter(ProviderEndpoint.name == provider_name).first()
        if existing:
            existing.provider_type = template["provider_type"]
            existing.base_url = template["base_url"]
            existing.api_key = stored_key
            existing.extra_headers = extra_headers
            existing.enabled = 1
            db.commit()
        else:
            row = ProviderEndpoint(
                name=provider_name,
                provider_type=template["provider_type"],
                base_url=template["base_url"],
                api_key=stored_key,
                extra_headers=extra_headers,
                enabled=1,
            )
            db.add(row)
            db.commit()

        return {"status": "complete"}

    error_code = data.get("error", "")
    if error_code == "authorization_pending":
        return {"status": "pending"}
    if error_code == "slow_down":
        return {"status": "slow_down", "interval": data.get("interval", ctx["interval"] + 5)}
    if error_code == "expired_token":
        _device_code_store.pop(session_id, None)
        return {"status": "expired"}

    _device_code_store.pop(session_id, None)
    return {"status": "error", "error": data.get("error_description", error_code)}


# ---------------------------------------------------------------------------
# Google Gemini — Authorization Code + PKCE  (like pi-mono's google-gemini-cli.ts)
# ---------------------------------------------------------------------------
@router.get("/common/oauth/start/{provider_key}")
def start_common_provider_oauth(provider_key: str, request: Request, name_override: str = ""):
    """Start Google Gemini OAuth with PKCE. Returns auth_url for the browser."""
    if provider_key not in ("google_gemini_openai", "google_gemini_cli"):
        raise HTTPException(status_code=400, detail="Browser-based OAuth is only supported for google_gemini_openai / google_gemini_cli. Use device code flow for github_models.")

    callback_url = str(request.url_for("common_provider_oauth_callback", provider_key=provider_key))

    client_id, client_secret = _get_google_creds()
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=400,
            detail=(
                "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET "
                "in the repo root .env or save google_client_id/google_client_secret in Settings first."
            ),
        )

    verifier, challenge = _generate_pkce()
    state = secrets.token_urlsafe(24)

    _pkce_store[state] = {
        "provider_key": provider_key,
        "name_override": name_override.strip(),
        "redirect_uri": callback_url,
        "code_verifier": verifier,
        "created_at": time.time(),
    }

    auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(
        {
            "client_id": client_id,
            "redirect_uri": callback_url,
            "response_type": "code",
            "scope": "openid email profile https://www.googleapis.com/auth/cloud-platform",
            "access_type": "offline",
            "prompt": "consent select_account",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    return {"auth_url": auth_url}


@router.get("/common/oauth/callback/{provider_key}", name="common_provider_oauth_callback")
async def common_provider_oauth_callback(
    provider_key: str, code: str = "", state: str = "", error: str = "", db: Session = Depends(get_db)
):
    """OAuth callback for Google Gemini with PKCE verification."""
    if error:
        return HTMLResponse(f"<html><body><h3>OAuth failed: {error}</h3></body></html>")
    if not code or not state:
        return HTMLResponse("<html><body><h3>OAuth failed: missing code/state</h3></body></html>")

    ctx = _pkce_store.pop(state, None)
    if not ctx or ctx.get("provider_key") != provider_key:
        return HTMLResponse("<html><body><h3>OAuth failed: invalid state</h3></body></html>")

    if provider_key not in ("google_gemini_openai", "google_gemini_cli"):
        return HTMLResponse("<html><body><h3>OAuth callback not supported for this provider</h3></body></html>")

    template = COMMON_PROVIDER_TEMPLATES[provider_key]
    provider_name = ctx.get("name_override") or provider_key
    redirect_uri = str(ctx.get("redirect_uri") or "")
    code_verifier = ctx.get("code_verifier", "")

    client_id, client_secret = _get_google_creds()

    # Exchange authorization code with PKCE verifier
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": code_verifier,
            },
        )
    payload = resp.json()
    access_token = str(payload.get("access_token") or "")
    refresh_token = str(payload.get("refresh_token") or "")
    expires_in = int(payload.get("expires_in", 3600))
    # 5-minute buffer before actual expiry (same as pi-agent)
    expires_at = time.time() + expires_in - 300
    if not access_token:
        err_detail = payload.get("error_description", payload.get("error", "unknown"))
        return HTMLResponse(f"<html><body><h3>OAuth failed: {err_detail}</h3></body></html>")

    # Fetch user email from Google userinfo to support multi-account naming
    account_email = ""
    try:
        async with httpx.AsyncClient(timeout=10.0) as info_client:
            info_resp = await info_client.get(
                "https://www.googleapis.com/oauth2/v3/userinfo",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if info_resp.status_code == 200:
                account_email = info_resp.json().get("email", "")
    except Exception:
        _provider_logger.warning("Failed to fetch Google userinfo for account naming")

    # Auto-generate provider name from email if no override given
    label = template["label"]
    if not ctx.get("name_override"):
        if account_email:
            provider_name = f"{label} ({account_email})"
        # else keep original provider_key as fallback

    # Store refresh_token + access_token + expires_at as JSON in api_key
    token_data = json.dumps({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_at": expires_at,
    })
    extra_headers = template["default_extra_headers"]

    existing = db.query(ProviderEndpoint).filter(ProviderEndpoint.name == provider_name).first()
    if existing:
        existing.provider_type = template["provider_type"]
        existing.base_url = template["base_url"]
        existing.api_key = token_data
        existing.extra_headers = extra_headers
        existing.enabled = 1
        db.commit()
    else:
        row = ProviderEndpoint(
            name=provider_name,
            provider_type=template["provider_type"],
            base_url=template["base_url"],
            api_key=token_data,
            extra_headers=extra_headers,
            enabled=1,
        )
        db.add(row)
        db.commit()

    html = """
    <html><body>
    <h3>Google Gemini OAuth connected successfully. You can close this window.</h3>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'provider-oauth-success' }, '*');
      }
      window.close();
    </script>
    </body></html>
    """
    return HTMLResponse(html)


# ---------------------------------------------------------------------------
# Token Refresh  (Google OAuth tokens expire; refresh transparently)
# ---------------------------------------------------------------------------
@router.post("/common/oauth/refresh/{provider_id}")
async def refresh_provider_token(provider_id: int, db: Session = Depends(get_db)):
    """Refresh an OAuth token for a provider (Google Gemini or GitHub Copilot)."""
    row = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == provider_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")

    if not row.api_key or not row.api_key.startswith("{"):
        raise HTTPException(status_code=400, detail="Provider does not use OAuth tokens")

    try:
        token_data = json.loads(row.api_key)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid token data in provider")

    # GitHub Copilot token refresh
    if _is_copilot_provider(row):
        github_token = token_data.get("github_token", "")
        if not github_token:
            raise HTTPException(status_code=400, detail="No GitHub token available for Copilot refresh")
        new_data = await _exchange_copilot_token(github_token)
        token_data["copilot_token"] = new_data["token"]
        token_data["expires_at"] = new_data["expires_at"]
        row.api_key = json.dumps(token_data)
        db.commit()
        return {"status": "refreshed"}

    # Google OAuth token refresh
    refresh_token = token_data.get("refresh_token")
    if not refresh_token:
        raise HTTPException(status_code=400, detail="No refresh token available")

    client_id, client_secret = _get_google_creds()

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Token refresh failed: {resp.text}")

    payload = resp.json()
    new_access = payload.get("access_token", "")
    if not new_access:
        raise HTTPException(status_code=502, detail="No access_token in refresh response")

    # Update stored token data (keep refresh_token, update access_token + expires_at)
    token_data["access_token"] = new_access
    expires_in = int(payload.get("expires_in", 3600))
    token_data["expires_at"] = time.time() + expires_in - 300  # 5-minute buffer
    if payload.get("refresh_token"):
        token_data["refresh_token"] = payload["refresh_token"]
    row.api_key = json.dumps(token_data)
    db.commit()

    return {"status": "refreshed"}


@router.get("", response_model=list[ProviderEndpointResponse])
def list_providers(db: Session = Depends(get_db)):
    return db.query(ProviderEndpoint).order_by(ProviderEndpoint.created_at.desc()).all()


@router.post("", response_model=ProviderEndpointResponse, status_code=201)
def create_provider(request: ProviderEndpointCreate, db: Session = Depends(get_db)):
    existing = db.query(ProviderEndpoint).filter(ProviderEndpoint.name == request.name).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Provider '{request.name}' already exists")

    row = ProviderEndpoint(
        name=request.name,
        provider_type=request.provider_type,
        base_url=request.base_url,
        api_key=request.api_key,
        extra_headers=request.extra_headers,
        enabled=1 if request.enabled else 0,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/{provider_id}", response_model=ProviderEndpointResponse)
def update_provider(provider_id: int, request: ProviderEndpointCreate, db: Session = Depends(get_db)):
    row = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == provider_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")

    row.name = request.name
    row.provider_type = request.provider_type
    row.base_url = request.base_url
    row.api_key = request.api_key
    row.extra_headers = request.extra_headers
    row.enabled = 1 if request.enabled else 0
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{provider_id}")
def delete_provider(provider_id: int, db: Session = Depends(get_db)):
    row = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == provider_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")

    route_count = db.query(ModelRoute).filter(ModelRoute.provider_id == provider_id).count()
    if route_count > 0:
        raise HTTPException(status_code=409, detail="Provider is still referenced by model routes")

    db.delete(row)
    db.commit()
    return {"message": "Provider deleted"}


@router.get("/{provider_id}/health")
async def provider_health(provider_id: int, db: Session = Depends(get_db)):
    row = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == provider_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")

    if row.provider_type == "local_process":
        return {"ok": True, "provider_type": row.provider_type, "detail": "Managed by local process manager"}

    if not row.base_url:
        raise HTTPException(status_code=400, detail="Provider base_url is empty")

    headers = build_provider_headers(row.api_key or "", row.extra_headers or "")
    url = build_provider_models_url(row.base_url or "")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=headers)
        return {
            "ok": resp.status_code < 400,
            "status_code": resp.status_code,
            "provider": row.name,
            "provider_type": row.provider_type,
            "url": url,
        }
    except httpx.RequestError as e:
        return {
            "ok": False,
            "provider": row.name,
            "provider_type": row.provider_type,
            "url": url,
            "error": str(e),
        }


@router.get("/{provider_id}/models", response_model=list[ProviderModelItem])
async def provider_models(provider_id: int, db: Session = Depends(get_db)):
    row = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == provider_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")

    if row.provider_type == "local_process":
        raise HTTPException(status_code=400, detail="local_process provider does not expose remote models endpoint")

    url = build_provider_models_url(row.base_url or "")
    if not url:
        raise HTTPException(status_code=400, detail="Provider base_url is empty")

    headers = build_provider_headers(row.api_key or "", row.extra_headers or "")
    fallback_models = _get_default_provider_models(row)
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, headers=headers)
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if response.status_code >= 400:
            if fallback_models:
                return fallback_models
            raise HTTPException(status_code=response.status_code, detail=payload)
    except httpx.RequestError as e:
        if fallback_models:
            return fallback_models
        raise HTTPException(status_code=502, detail=f"Unable to reach provider models endpoint: {e}")

    items = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return fallback_models

    models: list[ProviderModelItem] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "")
        if not model_id:
            continue
        models.append(
            ProviderModelItem(
                id=model_id,
                provider_name=row.name,
                raw=item,
            )
        )

    return models or fallback_models


@router.post("/sync-local", response_model=list[ProviderEndpointResponse])
async def sync_local_providers(db: Session = Depends(get_db)):
    """Auto-create provider entries for locally running llama-server processes and Ollama."""
    from backend.app.core.process_manager import llama_process_manager
    from backend.app.services import ollama_service as ols

    statuses = llama_process_manager.get_all_status()
    created: list[ProviderEndpoint] = []

    for s in statuses:
        if not s.get("is_running"):
            continue
        port = s.get("port")
        if not port:
            continue

        base_url = f"http://localhost:{port}"
        existing = db.query(ProviderEndpoint).filter(ProviderEndpoint.base_url == base_url).first()
        if existing:
            continue

        identifier = s.get("identifier") or f"local-{port}"
        name = f"local-{identifier}"
        # Avoid duplicate names
        if db.query(ProviderEndpoint).filter(ProviderEndpoint.name == name).first():
            name = f"local-{identifier}-{port}"

        row = ProviderEndpoint(
            name=name,
            provider_type="openai_compatible",
            base_url=base_url,
            api_key="",
            extra_headers="",
            enabled=1,
        )
        db.add(row)
        db.flush()
        created.append(row)

    # Also probe Ollama on default port
    ollama_status = await ols.get_status()
    if ollama_status.running:
        ollama_base = f"http://{ollama_status.host}:{ollama_status.port}"
        # Use /v1 endpoint for OpenAI-compatible routing
        ollama_api_base = f"{ollama_base}/v1"
        existing_ollama = db.query(ProviderEndpoint).filter(
            ProviderEndpoint.base_url.in_([ollama_base, ollama_api_base])
        ).first()
        if not existing_ollama:
            ollama_name = "Ollama (local)"
            if db.query(ProviderEndpoint).filter(ProviderEndpoint.name == ollama_name).first():
                ollama_name = f"Ollama-{ollama_status.port}"
            row = ProviderEndpoint(
                name=ollama_name,
                provider_type="openai_compatible",
                base_url=ollama_api_base,
                api_key="",
                extra_headers="",
                enabled=1,
            )
            db.add(row)
            db.flush()
            created.append(row)

    if created:
        db.commit()
        for row in created:
            db.refresh(row)

    return created


routes_router = APIRouter(prefix="/api/model-routes", tags=["model-routes"])


@routes_router.get("", response_model=list[ModelRouteResponse])
def list_model_routes(db: Session = Depends(get_db)):
    return db.query(ModelRoute).order_by(ModelRoute.priority.asc(), ModelRoute.created_at.asc()).all()


@routes_router.post("", response_model=ModelRouteResponse, status_code=201)
def create_model_route(request: ModelRouteCreate, db: Session = Depends(get_db)):
    provider = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == request.provider_id).first()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    row = ModelRoute(
        route_name=request.route_name,
        match_type=request.match_type,
        match_value=request.match_value,
        target_model=request.target_model,
        provider_id=request.provider_id,
        priority=request.priority,
        enabled=1 if request.enabled else 0,
        supports_tools=1 if request.supports_tools else 0,
        supports_vision=1 if request.supports_vision else 0,
        supports_thinking=1 if request.supports_thinking else 0,
        context_length=request.context_length,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@routes_router.put("/{route_id}", response_model=ModelRouteResponse)
def update_model_route(route_id: int, request: ModelRouteCreate, db: Session = Depends(get_db)):
    row = db.query(ModelRoute).filter(ModelRoute.id == route_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Model route not found")

    provider = db.query(ProviderEndpoint).filter(ProviderEndpoint.id == request.provider_id).first()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    row.route_name = request.route_name
    row.match_type = request.match_type
    row.match_value = request.match_value
    row.target_model = request.target_model
    row.provider_id = request.provider_id
    row.priority = request.priority
    row.enabled = 1 if request.enabled else 0
    row.supports_tools = 1 if request.supports_tools else 0
    row.supports_vision = 1 if request.supports_vision else 0
    row.supports_thinking = 1 if request.supports_thinking else 0
    row.context_length = request.context_length
    db.commit()
    db.refresh(row)
    return row


@routes_router.delete("/{route_id}")
def delete_model_route(route_id: int, db: Session = Depends(get_db)):
    row = db.query(ModelRoute).filter(ModelRoute.id == route_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Model route not found")
    db.delete(row)
    db.commit()
    return {"message": "Model route deleted"}


mesh_router = APIRouter(prefix="/api/mesh/workers", tags=["mesh-workers"])


@mesh_router.get("", response_model=list[MeshWorkerResponse])
def list_workers(db: Session = Depends(get_db)):
    return db.query(MeshWorker).order_by(MeshWorker.updated_at.desc()).all()


@mesh_router.post("/heartbeat", response_model=MeshWorkerResponse)
def upsert_worker_heartbeat(request: MeshWorkerUpsert, db: Session = Depends(get_db)):
    row = db.query(MeshWorker).filter(MeshWorker.node_name == request.node_name).first()
    now = datetime.now(timezone.utc)

    capability_fields = dict(
        supports_tools=int(request.supports_tools),
        supports_vision=int(request.supports_vision),
        supports_embeddings=int(request.supports_embeddings),
        max_context_length=request.max_context_length,
        current_load=request.current_load,
        gpu_memory_used_pct=request.gpu_memory_used_pct,
    )

    if row is None:
        row = MeshWorker(
            node_name=request.node_name,
            base_url=request.base_url,
            api_token=request.api_token,
            provider_id=request.provider_id,
            models_json=json.dumps(request.models),
            metadata_json=json.dumps(request.metadata),
            status=request.status,
            last_seen_at=now,
            consecutive_failures=0,
            **capability_fields,
        )
        db.add(row)
    else:
        row.base_url = request.base_url
        row.api_token = request.api_token
        row.provider_id = request.provider_id
        row.models_json = json.dumps(request.models)
        row.metadata_json = json.dumps(request.metadata)
        row.status = request.status
        row.last_seen_at = now
        # Reset failure counter on successful heartbeat
        row.consecutive_failures = 0
        for k, v in capability_fields.items():
            setattr(row, k, v)

    db.commit()
    db.refresh(row)
    return row


@mesh_router.delete("/{worker_id}")
def delete_worker(worker_id: int, db: Session = Depends(get_db)):
    row = db.query(MeshWorker).filter(MeshWorker.id == worker_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Worker not found")
    db.delete(row)
    db.commit()
    return {"message": "Worker deleted"}
