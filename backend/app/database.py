"""
資料庫初始化 - SQLAlchemy 引擎、Session 工廠與 Base
"""
from sqlalchemy import create_engine, event
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
    from backend.app.models import Setting, ModelGroup, BenchmarkRecord  # noqa: F401
    Base.metadata.create_all(bind=engine)
