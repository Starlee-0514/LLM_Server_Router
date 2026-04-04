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
  n_prompt?: number;
  n_gen?: number;
  flash_attn?: number;
  no_kv_offload?: number;
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
  let finalResults: any = {};

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
        const parsed = JSON.parse(data);
        if (eventType === "log") {
          onLog(parsed.line);
        } else if (eventType === "done") {
          finalResults = parsed;
        } else if (eventType === "error") {
          throw new Error(parsed.error || "Benchmark failed");
        }
      } catch (e: any) {
        if (e.message && !e.message.includes("JSON")) throw e;
      }
    }
  }

  return finalResults;
};

export const getBenchmarkHistory = () => apiFetch<BenchmarkRecord[]>("/api/benchmarks/history");
export const deleteBenchmark = (id: number) =>
  apiFetch(`/api/benchmarks/${id}`, { method: "DELETE" });
export const importBenchmarks = (records: any[]) =>
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
