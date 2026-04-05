"""
資料庫初始化 - SQLAlchemy 引擎、Session 工廠與 Base
"""
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from backend.app.core.config import settings

# 建立引擎（SQLite 需要開啟 WAL mode 以獲得更好的並發性能）
engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},  # SQLite 專用
    echo=False,
)


# 啟用 SQLite WAL 模式
@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


# Session 工廠
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# 宣告式基底
class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI 依賴注入用的資料庫 session 產生器。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """建立所有資料表 (如果不存在)。"""
    from backend.app.core.runtime_settings import ensure_default_runtimes
    from backend.app.models import (  # noqa: F401
        Setting,
        Runtime,
        ModelGroup,
        BenchmarkRecord,
        ProviderEndpoint,
        ModelRoute,
        ModelPropertyOverride,
        MeshWorker,
        CompletionLog,
        VirtualModel,
    )
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)

    model_group_columns = {column["name"] for column in inspector.get_columns("model_groups")}
    override_columns = {column["name"] for column in inspector.get_columns("model_property_overrides")}
    benchmark_columns = {column["name"] for column in inspector.get_columns("benchmark_records")}
    mesh_worker_columns = {column["name"] for column in inspector.get_columns("mesh_workers")}

    with engine.begin() as connection:
        if "model_family" not in model_group_columns:
            connection.execute(text("ALTER TABLE model_groups ADD COLUMN model_family VARCHAR(50) DEFAULT 'universal'"))
        if "preset_recipe" not in model_group_columns:
            connection.execute(text("ALTER TABLE model_groups ADD COLUMN preset_recipe VARCHAR(120) DEFAULT 'universal-balanced'"))
        if "model_family" not in override_columns:
            connection.execute(text("ALTER TABLE model_property_overrides ADD COLUMN model_family VARCHAR(50) DEFAULT ''"))
        if "preset_recipe" not in benchmark_columns:
            connection.execute(text("ALTER TABLE benchmark_records ADD COLUMN preset_recipe VARCHAR(120) DEFAULT ''"))
        # Phase 1: mesh worker capability + health fields
        if "supports_tools" not in mesh_worker_columns:
            connection.execute(text("ALTER TABLE mesh_workers ADD COLUMN supports_tools INTEGER NOT NULL DEFAULT 0"))
        if "supports_vision" not in mesh_worker_columns:
            connection.execute(text("ALTER TABLE mesh_workers ADD COLUMN supports_vision INTEGER NOT NULL DEFAULT 0"))
        if "supports_embeddings" not in mesh_worker_columns:
            connection.execute(text("ALTER TABLE mesh_workers ADD COLUMN supports_embeddings INTEGER NOT NULL DEFAULT 0"))
        if "max_context_length" not in mesh_worker_columns:
            connection.execute(text("ALTER TABLE mesh_workers ADD COLUMN max_context_length INTEGER"))
        if "current_load" not in mesh_worker_columns:
            connection.execute(text("ALTER TABLE mesh_workers ADD COLUMN current_load FLOAT DEFAULT 0.0"))
        if "gpu_memory_used_pct" not in mesh_worker_columns:
            connection.execute(text("ALTER TABLE mesh_workers ADD COLUMN gpu_memory_used_pct FLOAT"))
        if "consecutive_failures" not in mesh_worker_columns:
            connection.execute(text("ALTER TABLE mesh_workers ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0"))
        if "last_health_check_at" not in mesh_worker_columns:
            connection.execute(text("ALTER TABLE mesh_workers ADD COLUMN last_health_check_at DATETIME"))

    ensure_default_runtimes()
