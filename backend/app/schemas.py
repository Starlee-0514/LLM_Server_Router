"""
Pydantic 請求/回應模型 (Schemas)

用於 API 端點的輸入驗證與回應序列化。
"""
from datetime import datetime
from pydantic import BaseModel, Field


# =====================
# Settings
# =====================
class SettingResponse(BaseModel):
    """單一設定項目回應。"""
    id: int
    key: str
    value: str
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class SettingUpdate(BaseModel):
    """更新設定項目的請求。"""
    key: str
    value: str


class SettingsBulkUpdate(BaseModel):
    """批次更新設定的請求。"""
    settings: list[SettingUpdate]


# =====================
# Runtimes
# =====================
class RuntimeResponse(BaseModel):
    """運行時環境配置回應。"""
    id: int
    name: str
    description: str = ""
    executable_path: str
    environment_vars: str = "{}"
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class RuntimeCreate(BaseModel):
    """建立運行時環境的請求。"""
    name: str
    description: str = ""
    executable_path: str
    environment_vars: str = "{}"


class RuntimeUpdate(BaseModel):
    """更新運行時環境的請求。"""
    name: str | None = None
    description: str | None = None
    executable_path: str | None = None
    environment_vars: str | None = None


# =====================
# Model Scanner
# =====================
class GGUFFileInfo(BaseModel):
    """掃描到的 GGUF 檔案資訊。"""
    filename: str
    filepath: str
    size_bytes: int
    size_human: str  # e.g., "4.2 GB"
    parent_dir: str
    publisher: str = ""     # e.g., "lmstudio-community"
    quantize: str = ""      # e.g., "Q4_K_M"
    param_size: str = ""    # e.g., "9B"
    arch: str = ""          # e.g., "Qwen3.5"
    model_family: str = ""
    model_type: str = "text"  # text | multimodal_base | multimodal_projector
    related_mmproj_path: str = ""
    related_base_model_path: str = ""


class ModelScanRequest(BaseModel):
    """手動掃描指定目錄的請求。"""
    directories: list[str] = Field(
        ...,
        description="要掃描的目錄路徑列表",
        min_length=1,
    )


class ModelScanResponse(BaseModel):
    """模型掃描結果回應。"""
    total_count: int
    scanned_directories: list[str]
    models: list[GGUFFileInfo]
    errors: list[str] = Field(default_factory=list)


# =====================
# Model Group
# =====================
class ModelGroupCreate(BaseModel):
    """建立模型群組的請求。"""
    group_name: str = "Default"
    name: str
    description: str = ""
    model_path: str
    engine_type: str = "rocm"
    n_gpu_layers: int = 999
    batch_size: int = 512
    ubatch_size: int = 512
    ctx_size: int = 4096
    model_family: str = "universal"
    preset_recipe: str = "universal-balanced"
    extra_args: str = ""


class ModelGroupResponse(BaseModel):
    """模型群組回應。"""
    id: int
    group_name: str
    name: str
    description: str
    model_path: str
    engine_type: str
    n_gpu_layers: int
    batch_size: int
    ubatch_size: int
    ctx_size: int
    model_family: str
    preset_recipe: str
    extra_args: str
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


# =====================
# Process Manager
# =====================
class ProcessStartRequest(BaseModel):
    """啟動 llama-server 的請求。"""
    model_identifier: str = Field(..., description="用來辨識這個進程的唯一名稱 (例如: model檔名)")
    model_path: str
    engine_type: str = "rocm"
    n_gpu_layers: int = 999
    batch_size: int = 512
    ubatch_size: int = 512
    ctx_size: int = 4096
    extra_args: str = ""

class ProcessStatus(BaseModel):
    """llama-server 進程狀態。"""
    identifier: str
    is_running: bool
    pid: int | None = None
    engine_type: str | None = None
    model_path: str | None = None
    port: int | None = None
    uptime_seconds: float | None = None

class AllProcessesStatus(BaseModel):
    """所有管理中的進程狀態清單。"""
    active_count: int
    processes: list[ProcessStatus]

# =====================
# Benchmark
# =====================
class BenchmarkRunRequest(BaseModel):
    """執行效能測試的要求。"""
    model_name: str
    model_path: str
    engine_type: str = "rocm"
    n_gpu_layers: int = 999
    batch_size: int = 512
    ubatch_size: int = 512
    ctx_size: int = 4096
    preset_recipe: str = ""
    n_prompt: int = 512      # prompt tokens count
    n_gen: int = 128         # generation tokens count
    flash_attn: int = 0      # flash attention 0|1
    no_kv_offload: int = 0   # no kv offload 0|1
    cache_type_k: str = "f16"
    cache_type_v: str = "f16"

class BenchmarkRecordResponse(BaseModel):
    """效能測試結果回應。"""
    id: int
    model_name: str
    model_path: str
    engine_type: str
    n_gpu_layers: int
    batch_size: int
    ubatch_size: int
    ctx_size: int
    preset_recipe: str = ""
    pp_tokens_per_second: float | None = None
    tg_tokens_per_second: float | None = None
    raw_output: str = ""
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class BenchmarkImportRequest(BaseModel):
    """匯入效能測試紀錄的要求。"""
    records: list[BenchmarkRecordResponse]


# =====================
# Model Property Overrides
# =====================
class ModelPropertyOverrideCreate(BaseModel):
    """建立/更新模型屬性覆寫。"""
    filepath: str
    display_name: str = ""
    publisher: str = ""
    quantize: str = ""
    param_size: str = ""
    arch: str = ""
    model_family: str = ""
    tags: str = ""
    notes: str = ""


class ModelPropertyOverrideResponse(BaseModel):
    """模型屬性覆寫回應。"""
    id: int
    filepath: str
    display_name: str
    publisher: str
    quantize: str
    param_size: str
    arch: str
    model_family: str
    tags: str
    notes: str
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


# =====================
# Provider Router / Mesh
# =====================
class ProviderEndpointCreate(BaseModel):
    name: str
    provider_type: str = "openai_compatible"
    base_url: str = ""
    api_key: str = ""
    extra_headers: str = ""
    enabled: bool = True


class ProviderEndpointResponse(BaseModel):
    id: int
    name: str
    provider_type: str
    base_url: str | None = ""
    api_key: str | None = ""
    extra_headers: str
    enabled: bool
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class ModelRouteCreate(BaseModel):
    route_name: str
    match_type: str = "exact"
    match_value: str
    target_model: str = ""
    provider_id: int
    priority: int = 100
    enabled: bool = True
    supports_tools: bool = False
    supports_vision: bool = False
    supports_thinking: bool = False


class ModelRouteResponse(BaseModel):
    id: int
    route_name: str
    match_type: str
    match_value: str
    target_model: str | None = ""
    provider_id: int
    priority: int
    enabled: bool
    supports_tools: bool = False
    supports_vision: bool = False
    supports_thinking: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class MeshWorkerUpsert(BaseModel):
    node_name: str
    base_url: str
    api_token: str = ""
    provider_id: int | None = None
    models: list[str] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)
    status: str = "online"
    # capability fields (optional — workers can self-report)
    supports_tools: bool = False
    supports_vision: bool = False
    supports_embeddings: bool = False
    max_context_length: int | None = None
    current_load: float = 0.0
    gpu_memory_used_pct: float | None = None


class MeshWorkerResponse(BaseModel):
    id: int
    node_name: str
    base_url: str
    api_token: str = ""
    provider_id: int | None = None
    models_json: str
    metadata_json: str
    status: str
    supports_tools: bool = False
    supports_vision: bool = False
    supports_embeddings: bool = False
    max_context_length: int | None = None
    current_load: float = 0.0
    gpu_memory_used_pct: float | None = None
    consecutive_failures: int = 0
    last_seen_at: datetime | None = None
    last_health_check_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


# =====================
# Route Policy (Phase 2)
# =====================
class RoutePolicy(str):
    """Routing policy constants."""
    LOCAL_FIRST = "local_first"
    CHEAPEST = "cheapest"
    FASTEST = "fastest"
    HIGHEST_QUALITY = "highest_quality"
    LOCAL_ONLY = "local_only"
    REMOTE_ONLY = "remote_only"

    VALID = {"local_first", "cheapest", "fastest", "highest_quality", "local_only", "remote_only"}


class VirtualModelCreate(BaseModel):
    model_id: str
    display_name: str = ""
    description: str = ""
    routing_hints: dict = Field(default_factory=dict)
    enabled: bool = True


class VirtualModelResponse(BaseModel):
    id: int
    model_id: str
    display_name: str
    description: str
    routing_hints_json: str
    enabled: bool
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


# =====================
# Completion Log (Phase 4)
# =====================
class CompletionLogResponse(BaseModel):
    id: int
    model_requested: str
    model_resolved: str | None = ""
    provider_name: str | None = ""
    provider_type: str | None = ""
    prompt_tokens: int | None = 0
    completion_tokens: int | None = 0
    total_tokens: int | None = 0
    latency_ms: float | None = None
    tool_calls_count: int = 0
    success: bool = True
    error_message: str | None = ""
    conversation_id: str | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class CommonProviderTemplate(BaseModel):
    provider_key: str
    label: str
    provider_type: str
    base_url: str
    auth_hint: str
    default_extra_headers: str = ""
    oauth_method: str = "api_key"  # "api_key" | "device_code" | "pkce"


class CommonProviderRegisterRequest(BaseModel):
    provider_key: str
    api_key: str = ""
    enabled: bool = True
    name_override: str = ""


class ProviderModelItem(BaseModel):
    id: str
    provider_name: str
    raw: dict = Field(default_factory=dict)
