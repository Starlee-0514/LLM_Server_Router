"""
SQLAlchemy ORM 模型定義

- Setting: 系統設定 (key/value)，持久化 UI 配置項目（如模型掃描目錄）
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


class ModelGroup(Base):
    """模型群組 - 封裝一組 llama-server 啟動參數。

    一鍵啟動預設好的 llama-server 設定。
    """
    __tablename__ = "model_groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), unique=True, nullable=False)
    description = Column(Text, default="")
    model_path = Column(Text, nullable=False)          # .gguf 檔案路徑
    engine_type = Column(String(50), default="rocm")   # "rocm" | "vulkan"
    n_gpu_layers = Column(Integer, default=999)         # -ngl 參數
    batch_size = Column(Integer, default=512)           # -b 參數
    ubatch_size = Column(Integer, default=512)          # -ub 參數
    ctx_size = Column(Integer, default=4096)            # -c 參數
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

    @validates("engine_type")
    def validate_engine_type(self, key, value):
        allowed = {"rocm", "vulkan"}
        if value not in allowed:
            raise ValueError(f"engine_type 必須是 {allowed} 之一，收到: {value!r}")
        return value

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
