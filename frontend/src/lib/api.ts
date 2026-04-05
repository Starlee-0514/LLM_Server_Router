function getApiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== "undefined") {
    // Use the same hostname the browser loaded the page from, but on port 8000
    return `http://${window.location.hostname}:8000`;
  }
  return "http://localhost:8000";
}

// ==================
// Generic Fetcher
// ==================
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const base = getApiBase();
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || `API Error: ${res.status}`);
  }
  return res.json();
}

// ==================
// Types
// ==================
export interface GGUFFileInfo {
  filename: string;
  filepath: string;
  size_bytes: number;
  size_human: string;
  parent_dir: string;
  publisher: string;
  quantize: string;
  param_size: string;
  arch: string;
  model_family: string;
  model_type: "text" | "multimodal_base" | "multimodal_projector";
  related_mmproj_path: string;
  related_base_model_path: string;
}

export interface ModelScanResponse {
  total_count: number;
  scanned_directories: string[];
  models: GGUFFileInfo[];
  errors: string[];
}

export interface SettingItem {
  id: number;
  key: string;
  value: string;
  updated_at: string | null;
}

export interface ModelGroup {
  id: number;
  group_name: string;
  name: string;
  description: string;
  model_path: string;
  engine_type: string;
  n_gpu_layers: number;
  batch_size: number;
  ubatch_size: number;
  ctx_size: number;
  model_family: string;
  preset_recipe: string;
  extra_args: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface ProcessStatus {
  identifier: string;
  is_running: boolean;
  pid: number | null;
  engine_type: string | null;
  model_path: string | null;
  port: number | null;
  uptime_seconds: number | null;
  phase: string | null;
  recent_output: string[];
}

export interface AllProcessesStatus {
  active_count: number;
  processes: ProcessStatus[];
}

export interface BenchmarkRecord {
  id: number;
  model_name: string;
  model_path: string;
  engine_type: string;
  n_gpu_layers: number;
  batch_size: number;
  ubatch_size: number;
  ctx_size: number;
  preset_recipe: string;
  pp_tokens_per_second: number | null;
  tg_tokens_per_second: number | null;
  raw_output?: string;
  created_at: string | null;
}

export interface RequestMetrics {
  day: string;
  total: number;
  local: number;
  remote: number;
  local_ratio: number;
  remote_ratio: number;
}

export interface SystemMetrics {
  memory: {
    total_bytes: number | null;
    used_bytes: number | null;
    available_bytes: number | null;
    used_percent: number | null;
  };
  gpu: {
    busy_percent: number | null;
    vram_used_bytes: number | null;
    vram_total_bytes: number | null;
  };
}

export interface RecentBenchmarkItem {
  id: number;
  model_name: string;
  engine_type: string;
  pp_tokens_per_second: number | null;
  tg_tokens_per_second: number | null;
  created_at: string | null;
}

export interface Runtime {
  id: number;
  name: string;
  description: string;
  executable_path: string;
  environment_vars: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface OpenAIModelItem {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface OpenAIModelListResponse {
  object: string;
  data: OpenAIModelItem[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message?: {
      role: string;
      content: string;
    };
    delta?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ProviderEndpoint {
  id: number;
  name: string;
  provider_type: "openai_compatible" | "anthropic" | "local_process";
  base_url: string;
  api_key: string;
  extra_headers: string;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface ProviderCreatePayload {
  name: string;
  provider_type: "openai_compatible" | "anthropic" | "local_process";
  base_url: string;
  api_key: string;
  extra_headers: string;
  enabled: boolean;
}

export interface ProviderHealthResponse {
  ok: boolean;
  status_code?: number;
  provider?: string;
  provider_type?: string;
  url?: string;
  detail?: string;
  error?: string;
}

export interface CommonProviderTemplate {
  provider_key: string;
  label: string;
  provider_type: string;
  base_url: string;
  auth_hint: string;
  default_extra_headers: string;
  oauth_method: "api_key" | "device_code" | "pkce";
}

export interface CommonProviderRegisterPayload {
  provider_key: string;
  api_key: string;
  enabled: boolean;
  name_override: string;
}

export interface CommonProviderOAuthStartResponse {
  auth_url: string;
}

export interface DeviceCodeStartResponse {
  session_id: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceCodePollResponse {
  status: "pending" | "complete" | "slow_down" | "expired" | "error";
  interval?: number;
  error?: string;
}

export interface ProviderModelItem {
  id: string;
  provider_name: string;
  raw: Record<string, unknown>;
}

export interface ModelRouteItem {
  id: number;
  route_name: string;
  match_type: "exact" | "prefix";
  match_value: string;
  target_model: string;
  provider_id: number;
  priority: number;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface ModelRoutePayload {
  route_name: string;
  match_type: "exact" | "prefix";
  match_value: string;
  target_model: string;
  provider_id: number;
  priority: number;
  enabled: boolean;
}

export interface MeshWorker {
  id: number;
  node_name: string;
  base_url: string;
  api_token: string;
  provider_id: number | null;
  models_json: string;
  metadata_json: string;
  status: string;
  last_seen_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface MeshWorkerHeartbeatPayload {
  node_name: string;
  base_url: string;
  api_token: string;
  provider_id: number | null;
  models: string[];
  metadata: Record<string, unknown>;
  status: string;
}

// ==================
// API Functions
// ==================

// --- Status ---
export const getStatus = () => apiFetch<AllProcessesStatus>("/api/status");
export const getHealth = () => apiFetch<{ service: string; version: string; status: string }>("/");

// --- Settings ---
export const getSettings = () => apiFetch<SettingItem[]>("/api/settings");
export const updateSettings = (settings: { key: string; value: string }[]) =>
  apiFetch<SettingItem[]>("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ settings }),
  });

// --- Runtimes ---
export const getRuntimes = () => apiFetch<Runtime[]>("/api/runtimes");
export const getRuntime = (id: number) => apiFetch<Runtime>(`/api/runtimes/${id}`);
export const createRuntime = (runtime: Omit<Runtime, "id" | "created_at" | "updated_at">) =>
  apiFetch<Runtime>("/api/runtimes", {
    method: "POST",
    body: JSON.stringify(runtime),
  });
export const updateRuntime = (id: number, runtime: Partial<Omit<Runtime, "id" | "created_at" | "updated_at">>) =>
  apiFetch<Runtime>(`/api/runtimes/${id}`, {
    method: "PUT",
    body: JSON.stringify(runtime),
  });
export const deleteRuntime = (id: number) =>
  apiFetch(`/api/runtimes/${id}`, { method: "DELETE" });

// --- OpenAI-compatible inference ---
export const listInferenceModels = () => apiFetch<OpenAIModelListResponse>("/v1/models");

const parseChatError = async (res: Response) => {
  const body = await res.json().catch(async () => ({ detail: await res.text().catch(() => res.statusText) }));
  throw new Error(body.detail || body.error?.message || `API Error: ${res.status}`);
};

export const createChatCompletion = async (
  req: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<ChatCompletionResponse> => {
  const base = getApiBase();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, stream: false }),
    signal,
  });

  if (!res.ok) await parseChatError(res);
  return res.json();
};

export const streamChatCompletion = async (
  req: ChatCompletionRequest,
  onDelta: (delta: string, accumulated: string) => void,
  signal?: AbortSignal,
): Promise<{ content: string; usage?: ChatCompletionResponse["usage"] }> => {
  const base = getApiBase();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, stream: true }),
    signal,
  });

  if (!res.ok) await parseChatError(res);

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = (await res.json()) as ChatCompletionResponse;
    const message = payload.choices[0]?.message?.content ?? "";
    if (message) onDelta(message, message);
    return { content: message, usage: payload.usage };
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let usage: ChatCompletionResponse["usage"];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const lines = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      if (lines.length === 0) continue;

      for (const line of lines) {
        if (!line || line === "[DONE]") continue;

        const parsed = JSON.parse(line) as ChatCompletionResponse;
        const delta = parsed.choices[0]?.delta?.content ?? parsed.choices[0]?.message?.content ?? "";
        if (delta) {
          accumulated += delta;
          onDelta(delta, accumulated);
        }
        if (parsed.usage) usage = parsed.usage;
      }
    }
  }

  return { content: accumulated, usage };
};

// --- Models ---
export const scanModels = () => apiFetch<ModelScanResponse>("/api/models/scan");
export const scanCustomDirs = (directories: string[]) =>
  apiFetch<ModelScanResponse>("/api/models/scan", {
    method: "POST",
    body: JSON.stringify({ directories }),
  });

// --- Model Groups ---
export const getModelGroups = () => apiFetch<ModelGroup[]>("/api/model-groups");
export const createModelGroup = (group: Omit<ModelGroup, "id" | "created_at" | "updated_at">) =>
  apiFetch<ModelGroup>("/api/model-groups", {
    method: "POST",
    body: JSON.stringify(group),
  });
export const updateModelGroup = (id: number, group: Omit<ModelGroup, "id" | "created_at" | "updated_at">) =>
  apiFetch<ModelGroup>(`/api/model-groups/${id}`, {
    method: "PUT",
    body: JSON.stringify(group),
  });
export const deleteModelGroup = (id: number) =>
  apiFetch("/api/model-groups/" + id, { method: "DELETE" });
export const launchModelGroup = (id: number) =>
  apiFetch("/api/model-groups/" + id + "/launch", { method: "POST" });

// --- Process ---
export const startProcess = (req: {
  model_identifier: string;
  model_path: string;
  engine_type?: string;
  n_gpu_layers?: number;
  batch_size?: number;
  ubatch_size?: number;
  ctx_size?: number;
}) => apiFetch<ProcessStatus>("/api/process/start", { method: "POST", body: JSON.stringify(req) });
export const stopProcess = (identifier: string) =>
  apiFetch("/api/process/stop/" + identifier, { method: "POST" });
export const getAllProcessStatus = () => apiFetch<AllProcessesStatus>("/api/process/status");

// --- Benchmarks ---
export interface BenchmarkRunParams {
  model_name: string;
  model_path: string;
  engine_type?: string;
  n_gpu_layers?: number;
  batch_size?: number;
  ubatch_size?: number;
  ctx_size?: number;
  preset_recipe?: string;
  n_prompt?: number;
  n_gen?: number;
  flash_attn?: number;
  no_kv_offload?: number;
  cache_type_k?: string;
  cache_type_v?: string;
}

/**
 * Run benchmark with SSE streaming.
 * Receives real-time log lines via onLog callback.
 * Returns the final results when done.
 */
export const runBenchmarkStream = async (
  req: BenchmarkRunParams,
  onLog: (line: string) => void,
): Promise<{ pp_tokens_per_second?: number; tg_tokens_per_second?: number; raw_output?: string; record_id?: number }> => {
  const base = getApiBase();
  const res = await fetch(`${base}/api/benchmarks/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || `API Error: ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let finalResults: { pp_tokens_per_second?: number; tg_tokens_per_second?: number; raw_output?: string; record_id?: number } = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE events (separated by double newlines)
    const events = buffer.split("\n\n");
    buffer = events.pop() || ""; // keep incomplete event in buffer

    for (const event of events) {
      if (!event.trim()) continue;

      const lines = event.split("\n");
      let eventType = "";
      let data = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) eventType = line.slice(7).trim();
        if (line.startsWith("data: ")) data = line.slice(6);
      }

      if (!data) continue;

      try {
        const parsed = JSON.parse(data) as { line?: string; error?: string; pp_tokens_per_second?: number; tg_tokens_per_second?: number; raw_output?: string; record_id?: number };
        if (eventType === "log") {
          onLog(parsed.line ?? "");
        } else if (eventType === "done") {
          finalResults = parsed;
        } else if (eventType === "error") {
          throw new Error(parsed.error || "Benchmark failed");
        }
      } catch (error: unknown) {
        if (error instanceof Error && !error.message.includes("JSON")) throw error;
      }
    }
  }

  return finalResults;
};

export const getBenchmarkHistory = () => apiFetch<BenchmarkRecord[]>("/api/benchmarks/history");
export const deleteBenchmark = (id: number) =>
  apiFetch(`/api/benchmarks/${id}`, { method: "DELETE" });
export const importBenchmarks = (records: BenchmarkRecord[] | Record<string, unknown>[]) =>
  apiFetch("/api/benchmarks/import", {
    method: "POST",
    body: JSON.stringify({ records }),
  });

// --- Metrics ---
export const getRequestMetrics = () => apiFetch<RequestMetrics>("/api/metrics/requests");
export const getSystemMetrics = () => apiFetch<SystemMetrics>("/api/metrics/system");
export const getRecentBenchmarks = (limit = 5) =>
  apiFetch<RecentBenchmarkItem[]>(`/api/metrics/benchmarks/recent?limit=${limit}`);

// --- Providers ---
export const getProviders = () => apiFetch<ProviderEndpoint[]>("/api/providers");
export const createProvider = (payload: ProviderCreatePayload) =>
  apiFetch<ProviderEndpoint>("/api/providers", {
    method: "POST",
    body: JSON.stringify(payload),
  });
export const updateProvider = (id: number, payload: ProviderCreatePayload) =>
  apiFetch<ProviderEndpoint>(`/api/providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
export const deleteProvider = (id: number) =>
  apiFetch<{ message: string }>(`/api/providers/${id}`, {
    method: "DELETE",
  });
export const checkProviderHealth = (id: number) =>
  apiFetch<ProviderHealthResponse>(`/api/providers/${id}/health`);
export const getCommonProviderTemplates = () =>
  apiFetch<CommonProviderTemplate[]>("/api/providers/common/templates");
export const registerCommonProvider = (payload: CommonProviderRegisterPayload) =>
  apiFetch<ProviderEndpoint>("/api/providers/common/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
export const startCommonProviderOAuth = (providerKey: string, nameOverride = "") =>
  apiFetch<CommonProviderOAuthStartResponse>(`/api/providers/common/oauth/start/${providerKey}?name_override=${encodeURIComponent(nameOverride)}`);
export const startDeviceCodeFlow = (providerKey: string, nameOverride = "") =>
  apiFetch<DeviceCodeStartResponse>("/api/providers/common/oauth/device/start", {
    method: "POST",
    body: JSON.stringify({ provider_key: providerKey, name_override: nameOverride }),
  });
export const pollDeviceCodeFlow = (sessionId: string) =>
  apiFetch<DeviceCodePollResponse>("/api/providers/common/oauth/device/poll", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId }),
  });
export const refreshProviderToken = (providerId: number) =>
  apiFetch<{ status: string }>(`/api/providers/common/oauth/refresh/${providerId}`, {
    method: "POST",
  });
export const getProviderModels = (id: number) =>
  apiFetch<ProviderModelItem[]>(`/api/providers/${id}/models`);

// --- Model Routes ---
export const getModelRoutes = () => apiFetch<ModelRouteItem[]>("/api/model-routes");
export const createModelRoute = (payload: ModelRoutePayload) =>
  apiFetch<ModelRouteItem>("/api/model-routes", {
    method: "POST",
    body: JSON.stringify(payload),
  });
export const updateModelRoute = (id: number, payload: ModelRoutePayload) =>
  apiFetch<ModelRouteItem>(`/api/model-routes/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
export const deleteModelRoute = (id: number) =>
  apiFetch<{ message: string }>(`/api/model-routes/${id}`, {
    method: "DELETE",
  });

// --- Mesh Workers ---
export const getMeshWorkers = () => apiFetch<MeshWorker[]>("/api/mesh/workers");
export const upsertMeshWorkerHeartbeat = (payload: MeshWorkerHeartbeatPayload) =>
  apiFetch<MeshWorker>("/api/mesh/workers/heartbeat", {
    method: "POST",
    body: JSON.stringify(payload),
  });
export const deleteMeshWorker = (id: number) =>
  apiFetch<{ message: string }>(`/api/mesh/workers/${id}`, {
    method: "DELETE",
  });

// --- Model Property Overrides ---
export interface ModelPropertyOverride {
  id: number;
  filepath: string;
  display_name: string;
  publisher: string;
  quantize: string;
  param_size: string;
  arch: string;
  model_family: string;
  tags: string;
  notes: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface ModelPropertyOverridePayload {
  filepath: string;
  display_name: string;
  publisher: string;
  quantize: string;
  param_size: string;
  arch: string;
  model_family: string;
  tags: string;
  notes: string;
}

export const getModelOverrides = () =>
  apiFetch<ModelPropertyOverride[]>("/api/models/overrides");
export const upsertModelOverride = (payload: ModelPropertyOverridePayload) =>
  apiFetch<ModelPropertyOverride>("/api/models/overrides", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
export const deleteModelOverride = (id: number) =>
  apiFetch<{ message: string }>(`/api/models/overrides/${id}`, {
    method: "DELETE",
  });

// ==================
// Reports
// ==================
export interface ReportSummary {
  filename: string;
  title: string;
  report_type: string;
  created_at: string;
}

export interface ReportDetail {
  filename: string;
  content: string;
}

export interface ReportCreatePayload {
  report_type: string;
  title: string;
  component: string;
  priority: string;
  category: string;
  description: string;
  steps_to_reproduce?: string;
  expected_behavior?: string;
  actual_behavior?: string;
  proposed_adjustment?: string;
  benefits?: string;
  technical_notes?: string;
  effort?: string;
  environment?: string;
  console_errors?: string;
  additional_context?: string;
}

export const getReports = () =>
  apiFetch<ReportSummary[]>("/api/reports");

export const getReport = (filename: string) =>
  apiFetch<ReportDetail>(`/api/reports/${encodeURIComponent(filename)}`);

export const createReport = (payload: ReportCreatePayload) =>
  apiFetch<ReportSummary>("/api/reports", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const deleteReport = (filename: string) =>
  apiFetch<{ ok: boolean }>(`/api/reports/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  });

export const uploadReportImage = async (file: File): Promise<{ filename: string }> => {
  const base = getApiBase();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${base}/api/reports/upload-image`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || `Upload failed: ${res.status}`);
  }
  return res.json();
};

export const getReportImageUrl = (filename: string): string => {
  const base = getApiBase();
  return `${base}/api/reports/images/${encodeURIComponent(filename)}`;
};

// ==================
// Dev / Monitor
// ==================
export interface DevEvent {
  timestamp: string;
  type: string;
  identifier: string;
  detail: string;
  [key: string]: unknown;
}

export interface DevProcessDetail {
  identifier: string;
  is_running: boolean;
  pid: number | null;
  engine_type: string | null;
  model_path: string | null;
  port: number | null;
  uptime_seconds: number | null;
  command: string;
  phase: string | null;
  recent_output: string[];
}

export interface DevLogEntry {
  timestamp: string;
  level: string;
  logger: string;
  message: string;
}

export const getDevEvents = (limit = 100) =>
  apiFetch<DevEvent[]>(`/api/dev/events?limit=${limit}`);
export const getDevProcesses = () =>
  apiFetch<DevProcessDetail[]>("/api/dev/processes");
export const getDevLogs = (limit = 200) =>
  apiFetch<DevLogEntry[]>(`/api/dev/logs?limit=${limit}`);

export interface CompletionRecord {
  timestamp: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  elapsed: number;
  target: string;
  prompt_preview: string;
}

export const getDevCompletions = (limit = 50) =>
  apiFetch<CompletionRecord[]>(`/api/dev/completions?limit=${limit}`);

// ---------------------------------------------------------------------------
// Frontend Logger — sends frontend console logs to backend for persistence
// ---------------------------------------------------------------------------
interface FrontendLogEntry {
  timestamp: string;
  level: string;
  source: string;
  message: string;
}

const _pendingLogs: FrontendLogEntry[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function _flushFrontendLogs() {
  if (_pendingLogs.length === 0) return;
  const batch = _pendingLogs.splice(0, 100);
  const apiBase = getApiBase();
  // Fire-and-forget — don't block UI
  fetch(`${apiBase}/api/dev/logs/frontend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logs: batch }),
  }).catch(() => {}); // silently ignore failures
}

function _scheduleFrontendFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    _flushFrontendLogs();
  }, 2000);
}

export function frontendLog(level: string, source: string, message: string) {
  _pendingLogs.push({
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
  });
  _scheduleFrontendFlush();
}

export interface LogFileInfo {
  name: string;
  size_bytes: number;
  modified: string;
}

export const getLogFiles = () =>
  apiFetch<LogFileInfo[]>("/api/dev/logs/files");

export const getLogFileUrl = (filename: string) =>
  `${getApiBase()}/api/dev/logs/files/${encodeURIComponent(filename)}`;

// ==================
// Virtual Models (Forwarding / Alias Mapping)
// ==================
export interface RoutePolicyOption {
  value: string;
  label: string;
}

export interface RoutingHints {
  preferred_policy?: string;
  requires_tools?: boolean;
  requires_vision?: boolean;
  preferred_provider_ids?: number[];
  fallback_provider_id?: number | null;
}

export interface VirtualModelItem {
  id: number;
  model_id: string;
  display_name: string;
  description: string;
  routing_hints_json: string;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface VirtualModelPayload {
  model_id: string;
  display_name: string;
  description: string;
  routing_hints: RoutingHints;
  enabled: boolean;
}

export const getVirtualModels = () =>
  apiFetch<VirtualModelItem[]>("/api/virtual-models");

export const getRoutePolicies = () =>
  apiFetch<RoutePolicyOption[]>("/api/virtual-models/policies");

export const createVirtualModel = (payload: VirtualModelPayload) =>
  apiFetch<VirtualModelItem>("/api/virtual-models", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const updateVirtualModel = (id: number, payload: VirtualModelPayload) =>
  apiFetch<VirtualModelItem>(`/api/virtual-models/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

export const deleteVirtualModel = (id: number) =>
  apiFetch<void>(`/api/virtual-models/${id}`, { method: "DELETE" });

// ==================
// LM Studio
// ==================
export interface LMStudioStatus {
  running: boolean;
  port: number;
  host: string;
  loaded_models: string[];
  available_models: string[];
  error: string;
}

export interface LMStudioCliCheck {
  available: boolean;
  message: string;
}

export interface LMStudioCommandResult {
  success: boolean;
  message: string;
  stdout: string;
  stderr: string;
}

export interface LMStudioProviderRegistered {
  id: number;
  name: string;
  base_url: string;
  created: boolean;
}

export const getLMStudioCliStatus = () =>
  apiFetch<LMStudioCliCheck>("/api/lmstudio/cli");

export const getLMStudioStatus = (host = "127.0.0.1", port = 1234) =>
  apiFetch<LMStudioStatus>(`/api/lmstudio/status?host=${host}&port=${port}`);

export const lmStudioServerStart = (port = 1234, bind?: string) =>
  apiFetch<LMStudioCommandResult>("/api/lmstudio/server/start", {
    method: "POST",
    body: JSON.stringify({ port, bind: bind ?? null }),
  });

export const lmStudioServerStop = () =>
  apiFetch<LMStudioCommandResult>("/api/lmstudio/server/stop", { method: "POST" });

export const lmStudioModelLoad = (identifier: string, gpu?: number, ctx_length?: number) =>
  apiFetch<LMStudioCommandResult>("/api/lmstudio/models/load", {
    method: "POST",
    body: JSON.stringify({ identifier, gpu: gpu ?? null, ctx_length: ctx_length ?? null }),
  });

export const lmStudioModelUnload = (identifier?: string, unload_all = false) =>
  apiFetch<LMStudioCommandResult>("/api/lmstudio/models/unload", {
    method: "POST",
    body: JSON.stringify({ identifier: identifier ?? null, unload_all }),
  });

export const lmStudioRegisterProvider = (host = "127.0.0.1", port = 1234, name = "LM Studio") =>
  apiFetch<LMStudioProviderRegistered>("/api/lmstudio/provider/register", {
    method: "POST",
    body: JSON.stringify({ host, port, name, enabled: true }),
  });
