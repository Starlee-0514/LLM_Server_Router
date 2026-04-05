"""
SQLAlchemy ORM 模型定義

- Setting: 系統設定 (key/value)，持久化 UI 配置項目（如模型掃描目錄）
- Runtime: 運行時環境配置（如 rocm, vulkan 等自訂執行環境）
- ModelGroup: 模型群組預設參數
- BenchmarkRecord: llama-bench 效能測試結果
"""
import json
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import validates

from backend.app.database import Base


class Setting(Base):
    """系統設定鍵值表，儲存 UI 可配置的項目。

    保留的 key:
        - "model_scan_dirs": JSON 陣列，記錄掃描 GGUF 的目錄路徑
        - "default_engine": "rocm" | "vulkan"
    """
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(255), unique=True, nullable=False, index=True)
    value = Column(Text, nullable=False, default="")
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    def __repr__(self) -> str:
        return f"<Setting(key={self.key!r}, value={self.value!r})>"


class Runtime(Base):
    """運行時環境配置 - 定義 llama-server 執行環境（如 rocm, vulkan, etc）。

    允許使用者自訂和管理不同的運行時環境。
    """
    __tablename__ = "runtimes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
    description = Column(Text, default="")
    executable_path = Column(Text, nullable=False)  # 執行檔路徑或命令
    environment_vars = Column(Text, default="{}")   # JSON 格式的環境變數
    created_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    def __repr__(self) -> str:
        return f"<Runtime(name={self.name!r}, path={self.executable_path!r})>"


class ModelGroup(Base):
    """模型群組 - 封裝一組 llama-server 啟動參數。

    一鍵啟動預設好的 llama-server 設定。
    """
    __tablename__ = "model_groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    group_name = Column(String(255), default="Default", index=True)
    name = Column(String(255), unique=True, nullable=False)
    description = Column(Text, default="")
    model_path = Column(Text, nullable=False)          # .gguf 檔案路徑
    engine_type = Column(String(50), default="rocm")   # 運行時名稱（可自訂）
    n_gpu_layers = Column(Integer, default=999)         # -ngl 參數
    batch_size = Column(Integer, default=512)           # -b 參數
    ubatch_size = Column(Integer, default=512)          # -ub 參數
    ctx_size = Column(Integer, default=4096)            # -c 參數
    model_family = Column(String(50), default="universal")
    preset_recipe = Column(String(120), default="universal-balanced")
    extra_args = Column(Text, default="")               # 額外參數 (JSON 陣列)
    created_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    def __repr__(self) -> str:
        return f"<ModelGroup(name={self.name!r}, engine={self.engine_type})>"


class BenchmarkRecord(Base):
    """llama-bench 效能測試結果紀錄。

    從 llama-bench stdout 解析出的 t/s 數據。
    """
    __tablename__ = "benchmark_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    model_name = Column(String(255), nullable=False, index=True)
    model_path = Column(Text, nullable=False)
    engine_type = Column(String(50), nullable=False)       # "rocm" | "vulkan"
    n_gpu_layers = Column(Integer, nullable=False)
    batch_size = Column(Integer, nullable=False)
    ubatch_size = Column(Integer, nullable=False)
    ctx_size = Column(Integer, nullable=False)
    pp_tokens_per_second = Column(Float, nullable=True)    # prompt processing t/s
    tg_tokens_per_second = Column(Float, nullable=True)    # text generation t/s
    raw_output = Column(Text, default="")                  # llama-bench 完整輸出
    created_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
    )

    def __repr__(self) -> str:
        return (
            f"<BenchmarkRecord(model={self.model_name!r}, "
            f"pp={self.pp_tokens_per_second}, tg={self.tg_tokens_per_second})>"
        )


class ProviderEndpoint(Base):
    """通用 Provider 端點定義。

    provider_type:
      - openai_compatible: /v1/chat/completions + /v1/models
      - anthropic: /v1/messages (需轉換)
      - local_process: 由本機 process manager 管理 (llama.cpp)
    """

    __tablename__ = "provider_endpoints"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
    provider_type = Column(String(50), nullable=False, default="openai_compatible")
    base_url = Column(Text, nullable=True, default="")
    api_key = Column(Text, nullable=True, default="")
    extra_headers = Column(Text, nullable=False, default="")  # JSON object string
    enabled = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    @validates("provider_type")
    def validate_provider_type(self, key, value):
        allowed = {"openai_compatible", "anthropic", "local_process"}
        if value not in allowed:
            raise ValueError(f"provider_type 必須是 {allowed} 之一，收到: {value!r}")
        return value


class ModelRoute(Base):
    """模型路由規則：把 model 名稱映射到特定 provider。"""

    __tablename__ = "model_routes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    route_name = Column(String(255), unique=True, nullable=False, index=True)
    match_type = Column(String(20), nullable=False, default="exact")  # exact | prefix
    match_value = Column(String(255), nullable=False, index=True)
    target_model = Column(String(255), nullable=True, default="")
    provider_id = Column(Integer, nullable=False, index=True)
    priority = Column(Integer, nullable=False, default=100)
    enabled = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    @validates("match_type")
    def validate_match_type(self, key, value):
        allowed = {"exact", "prefix"}
        if value not in allowed:
            raise ValueError(f"match_type 必須是 {allowed} 之一，收到: {value!r}")
        return value


class ModelPropertyOverride(Base):
    """使用者自訂模型屬性覆寫。

    允許使用者覆寫 GGUF 掃描自動偵測的 metadata，
    例如 param_size, quantize, arch, publisher 等欄位。
    以 filepath 為 key 來識別唯一模型。
    """
    __tablename__ = "model_property_overrides"

    id = Column(Integer, primary_key=True, autoincrement=True)
    filepath = Column(Text, unique=True, nullable=False, index=True)
    display_name = Column(String(255), nullable=True, default="")
    publisher = Column(String(255), nullable=True, default="")
    quantize = Column(String(50), nullable=True, default="")
    param_size = Column(String(50), nullable=True, default="")
    arch = Column(String(255), nullable=True, default="")
    model_family = Column(String(50), nullable=True, default="")
    tags = Column(Text, nullable=True, default="")      # comma-separated custom tags
    notes = Column(Text, nullable=True, default="")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class MeshWorker(Base):
    """Tailscale Mesh 節點註冊表。"""

    __tablename__ = "mesh_workers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    node_name = Column(String(255), unique=True, nullable=False, index=True)
    base_url = Column(Text, nullable=False)
    api_token = Column(Text, nullable=False, default="")
    provider_id = Column(Integer, nullable=True, index=True)
    models_json = Column(Text, nullable=False, default="[]")
    metadata_json = Column(Text, nullable=False, default="{}")
    status = Column(String(50), nullable=False, default="unknown")
    last_seen_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
