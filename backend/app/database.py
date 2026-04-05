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
    )
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)

    model_group_columns = {column["name"] for column in inspector.get_columns("model_groups")}
    override_columns = {column["name"] for column in inspector.get_columns("model_property_overrides")}

    with engine.begin() as connection:
        if "model_family" not in model_group_columns:
            connection.execute(text("ALTER TABLE model_groups ADD COLUMN model_family VARCHAR(50) DEFAULT 'universal'"))
        if "preset_recipe" not in model_group_columns:
            connection.execute(text("ALTER TABLE model_groups ADD COLUMN preset_recipe VARCHAR(120) DEFAULT 'universal-balanced'"))
        if "model_family" not in override_columns:
            connection.execute(text("ALTER TABLE model_property_overrides ADD COLUMN model_family VARCHAR(50) DEFAULT ''"))

    ensure_default_runtimes()
