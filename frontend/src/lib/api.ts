const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// ==================
// Generic Fetcher
// ==================
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
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
  created_at: string | null;
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
export const runBenchmark = (req: {
  model_name: string;
  model_path: string;
  engine_type?: string;
  n_gpu_layers?: number;
  batch_size?: number;
  ubatch_size?: number;
  ctx_size?: number;
}) => apiFetch("/api/benchmarks/run", { method: "POST", body: JSON.stringify(req) });
export const getBenchmarkHistory = () => apiFetch<BenchmarkRecord[]>("/api/benchmarks/history");
