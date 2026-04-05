# Plan: LLM Server Router — Full Improvement Roadmap

## TL;DR
Evolve LLM_Server_Router from a working single-hub setup into a production-grade multi-device LLM mesh with intelligent routing, reliable tool calling, plugin extensibility, and simonw/llm as both a CLI client and architectural reference. 5 phases, ordered by dependency and impact.

---

## Phase 1: Mesh Reliability & Worker Health (Foundation)
*Everything else depends on knowing which workers are alive and what they can do.*

1. **Enrich worker heartbeat payload** — Add capability fields to `MeshWorker` model and heartbeat endpoint: `supports_tools`, `supports_vision`, `max_context_length`, `supported_formats` (chat, completion, embedding), `current_load` (active requests / queue depth), `gpu_memory_used_pct`. Update `POST /api/mesh/workers/heartbeat` schema accordingly.
   - Files: `backend/app/models.py` (MeshWorker model), `backend/app/schemas.py` (heartbeat schema), `backend/app/api/mesh.py`

2. **Implement server-side health checks** — Background task (every 30s) pings each registered worker's `/v1/models` or `/health`. Mark workers `stale` after 2 missed heartbeats, `offline` after 5. Add `last_health_check`, `status` (online/stale/offline), `consecutive_failures` to MeshWorker.
   - Files: `backend/app/services/` (new `mesh_health.py`), `backend/app/main.py` (startup task registration)

3. **TTL-based eviction** — Workers not seen for configurable TTL (default 5 min) are auto-removed from active pool but retained in DB with `offline` status for history.

4. **Worker capability inventory via `/v1/models`** — On heartbeat or health check, fetch the worker's `/v1/models` response and cache its available model list + capabilities. This feeds Phase 2 routing.
   - Files: `backend/app/services/mesh_health.py`

**Verification:**
- Start 2+ workers, confirm heartbeats register with enriched fields
- Kill one worker, verify it transitions online → stale → offline within expected TTL
- Check `/api/mesh/workers` returns accurate capability data

---

## Phase 2: Intelligent Routing (Core Value)
*Route by capability + score + cost, not just name matching.*

5. **Introduce route policies** — Add a `RoutePolicy` enum/model: `local_first`, `cheapest`, `fastest`, `highest_quality`, `local_only`, `remote_only`. Store as default in Settings, allow per-request override via `X-Route-Policy` header.
   - Files: `backend/app/models.py`, `backend/app/schemas.py`, `backend/app/api/openai_router.py`

6. **Capability-aware model resolution** — When a request arrives at `/v1/chat/completions`:
   a. Parse request for capability requirements (has `tools`? has image attachments? context length needed?)
   b. Filter available backends (local processes + mesh workers + providers) by capability match
   c. Score candidates using policy (benchmark pp/tg scores for `fastest`, cost tier for `cheapest`, etc.)
   d. Select best; if unavailable, cascade through fallback chain
   - Files: `backend/app/services/` (new `route_resolver.py`), `backend/app/api/openai_router.py`

7. **Stable virtual model IDs** — Expose logical model names via `GET /v1/models`: `coding`, `chat`, `fast`, `vision`, `cheap`. Map internally to best available backend. Clients use stable IDs; router resolves dynamically.
   - Files: `backend/app/api/openai_router.py`, `backend/app/models.py` (new VirtualModel or extend ModelRoute)

8. **Load-aware distribution** — When multiple workers serve the same model, distribute requests using weighted round-robin based on `current_load` from heartbeats. Simple implementation first (no distributed lock needed for single hub).
   - Files: `backend/app/services/route_resolver.py`

**Verification:**
- Request with `tools` parameter routes only to tool-capable backends
- With `X-Route-Policy: cheapest`, verify cloud provider selection order
- Kill the primary backend; verify automatic failover to next candidate
- `GET /v1/models` returns stable virtual model IDs

---

## Phase 3: Tool/Function Calling Quality (High User Impact)
*Borrowing patterns from ref repo's Tool abstraction.*

9. **Normalize tool schema translation** — Accept OpenAI-style `tools` from clients. When routing to Anthropic, translate to Anthropic tool format. When routing to local llama-server, verify it supports the grammar/tool mode.
   - Reference: `ref_repo/llm/default_plugins/openai_models.py` — `build_kwargs()` method for tool schema construction
   - Files: `backend/app/services/` (new `tool_normalizer.py`), `backend/app/api/openai_router.py`

10. **Argument validation + retry** — When model returns tool call arguments, validate against the original JSON schema. If invalid, inject a corrective system message and retry once (configurable). Return structured error if retry also fails.
    - Reference: `ref_repo/llm/tools.py` — `Tool._validate()` pattern
    - Files: `backend/app/services/tool_normalizer.py`

11. **Tool-call loop safety** — Add configurable limits: `max_tool_iterations` (default 10), `tool_call_timeout` (default 30s per call), `tool_allowlist` per route. Prevent infinite tool-call chains.
    - Reference: `ref_repo/llm/models.py` — `Response` class tool call loop with `_force_stop`
    - Files: `backend/app/api/openai_router.py`

12. **Tool discovery endpoint** — `GET /v1/tools` returns available server-side tools (if any are registered). Follows the ref repo's `register_tools` hookspec pattern but simplified.
    - Files: `backend/app/api/` (new `tools.py` router)

**Verification:**
- Send OpenAI-format tool call through router to Anthropic provider; verify translation
- Send malformed tool arguments; verify validation catches it and retry produces correct result
- Trigger 15 tool iterations; verify the router stops at max_tool_iterations and returns error
- `GET /v1/tools` returns registered tools

---

## Phase 4: Extensibility & Logging (Borrowed from ref repo)
*Plugin-lite provider system + conversation/request logging.*

13. **Provider adapter abstraction** — Extract current per-provider logic (OpenAI, Anthropic, GitHub Copilot, Google) into a `ProviderAdapter` base class with standard interface: `build_headers()`, `build_request_body()`, `parse_response()`, `parse_streaming_chunk()`, `translate_tools()`. Each provider gets its own adapter module.
    - Reference: `ref_repo/llm/default_plugins/openai_models.py` — `_Shared` + `Chat` class hierarchy
    - Files: `backend/app/services/` (new `adapters/` directory with `base.py`, `openai_adapter.py`, `anthropic_adapter.py`, `copilot_adapter.py`, `google_adapter.py`)

14. **Request/response logging** — Log every `/v1/chat/completions` request+response to a new `CompletionLog` table: timestamp, model_requested, model_resolved, provider_used, token_counts, latency_ms, tool_calls_count, success/error, truncated messages. Enable replay and cost tracking.
    - Reference: `ref_repo/llm/migrations.py` — conversation/response logging schema
    - Files: `backend/app/models.py` (new CompletionLog model), `backend/app/api/openai_router.py`

15. **Conversation tracking** — Optional session-based conversation persistence. When client sends a `X-Conversation-ID` header, store message history server-side and auto-inject prior context. Enables stateful multi-turn from stateless clients.
    - Reference: `ref_repo/llm/models.py` — `_BaseConversation` class
    - Files: `backend/app/models.py` (new Conversation, Message models), `backend/app/services/` (new `conversation.py`)

16. **Cost tracking** — Per-provider token pricing table. Compute estimated cost per request from token counts. Dashboard shows daily/weekly/monthly cost breakdown by provider.
    - Files: `backend/app/models.py` (new ProviderPricing model), `backend/app/api/metrics.py`, frontend dashboard

**Verification:**
- Add a new provider using only the adapter interface; verify it works without modifying router code
- Make 10 requests; verify CompletionLog table has 10 entries with correct metadata
- Send 3 requests with same X-Conversation-ID; verify context is maintained
- Dashboard shows cost breakdown matching manual calculation

---

## Phase 5: CLI Integration & Developer Experience
*Wire simonw/llm as a power-user frontend to your router.*

17. **`llm` CLI integration** — Configure `llm` to use your router as an OpenAI-compatible endpoint. Document the setup: `llm keys set openai`, set `OPENAI_API_BASE=http://<hub>:8000/v1`. Verify `llm chat`, `llm -m <virtual-model>`, `llm models` all work against the router.
    - Files: `docs/` (new `CLI_SETUP.md`)

18. **Embeddings endpoint** — Add `POST /v1/embeddings` to the router, proxying to local embedding models (llama.cpp with embedding mode) or remote providers. This enables `llm embed` workflows against your hub.
    - Reference: `ref_repo/llm/embeddings.py` — `Collection.embed_multi_with_metadata()` for batch handling
    - Files: `backend/app/api/` (new `embeddings.py` router), `backend/app/services/` (new `embedding_service.py`)

19. **Prompt templates endpoint** — `GET/POST /v1/templates` for storing and retrieving reusable prompt templates server-side. Shared across all devices.
    - Reference: `ref_repo/llm/templates.py` — Template class with $variable interpolation
    - Files: `backend/app/models.py` (new PromptTemplate model), `backend/app/api/` (new `templates.py`)

20. **Hub auth consolidation** — Single API key for the router; all cloud provider keys stored server-side only. No client needs to know individual provider keys. Document the security model.
    - Files: `backend/app/core/config.py`, `docs/` (update SETUP.md)

**Verification:**
- `llm chat -m coding` connects to router and gets a response
- `llm embed -m text-embedding-3-small -c "test"` gets embedding vector via router
- `llm templates list` shows server-stored templates
- Client with only hub API key can access all providers

---

## Relevant Files

**Backend core (modify):**
- `backend/app/models.py` — Add MeshWorker fields, CompletionLog, Conversation, VirtualModel, PromptTemplate, ProviderPricing
- `backend/app/schemas.py` — Enriched heartbeat, route policy, tool schemas
- `backend/app/api/openai_router.py` — Route resolution, tool normalization, conversation tracking, logging
- `backend/app/api/mesh.py` — Enriched heartbeat handling
- `backend/app/api/metrics.py` — Cost tracking endpoints
- `backend/app/core/config.py` — Route policy defaults, auth consolidation

**Backend new files:**
- `backend/app/services/mesh_health.py` — Background health check task
- `backend/app/services/route_resolver.py` — Capability-aware model resolution + load balancing
- `backend/app/services/tool_normalizer.py` — Cross-provider tool schema translation + validation
- `backend/app/services/adapters/` — Provider adapter hierarchy (base, openai, anthropic, copilot, google)
- `backend/app/services/conversation.py` — Server-side conversation management
- `backend/app/services/embedding_service.py` — Embedding proxy
- `backend/app/api/tools.py` — Tool discovery endpoint
- `backend/app/api/embeddings.py` — Embeddings endpoint
- `backend/app/api/templates.py` — Prompt templates endpoint

**Frontend (modify):**
- Dashboard — Cost breakdown widget, worker health status indicators
- Mesh page — Worker capability display, health status visualization
- Settings — Route policy configuration, virtual model ID mapping

**Docs:**
- `docs/CLI_SETUP.md` — simonw/llm integration guide
- `docs/SETUP.md` — Updated auth/security documentation

**Reference patterns (read-only):**
- `ref_repo/llm/models.py` — Response streaming, Conversation, Tool calling loop
- `ref_repo/llm/tools.py` — Tool schema extraction and validation
- `ref_repo/llm/default_plugins/openai_models.py` — OpenAI adapter pattern, build_kwargs, build_messages
- `ref_repo/llm/embeddings.py` — Batch embedding with Collection
- `ref_repo/llm/templates.py` — Template interpolation
- `ref_repo/llm/hookspecs.py` — Plugin registration hooks

---

## Decisions

- **Single hub architecture** — No hub-to-hub state sync. Each hub is authoritative for its mesh. Multi-hub would be a future phase.
- **SQLite stays** — Adequate for 5-15 devices. Migration to PostgreSQL only if concurrent write contention becomes measurable.
- **Provider adapters over plugins** — Full pluggy plugin system is overkill at this stage. Python class hierarchy with adapter pattern provides extensibility without the complexity.
- **Virtual model IDs** — Introduced alongside existing physical model routing, not replacing it. Power users can still target `worker-x:ModelName` directly.
- **Conversation persistence is opt-in** — Only when `X-Conversation-ID` header is present. Default behavior remains stateless pass-through.
- **`llm` CLI is complementary** — It's a client-side power tool, not replacing the web UI or API.

---

## Further Considerations

1. **Embedding model management** — Should the router auto-detect which workers can serve embeddings, or require explicit `/v1/embeddings`-capable flag in heartbeat? *Recommendation: explicit flag in heartbeat, same as tool support.*

2. **WebSocket streaming** — Current SSE streaming works for benchmarks. Should `/v1/chat/completions` streaming also support WebSocket for lower overhead on high-throughput mesh? *Recommendation: defer — SSE is standard for OpenAI-compatible clients.*

3. **Model preloading / warm pool** — With 5+ devices, should the hub be able to tell a worker "preload model X" proactively (e.g., before business hours)? *Recommendation: add `POST /api/mesh/workers/{id}/preload` in Phase 2 as stretch goal.*
