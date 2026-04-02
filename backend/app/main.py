"""
LLM Server Router - FastAPI 主應用程式

啟動方式:
    uvicorn backend.app.main:app --reload --port 8000
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.database import init_db
from backend.app.api.routers import model_routes, settings_routes, process_routes, benchmark_routes, openai_router
from backend.app.core.process_manager import llama_process_manager

# 設定 logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """應用程式生命週期管理。"""
    # === Startup ===
    logger.info("🚀 LLM Server Router 正在啟動...")
    init_db()
    logger.info("✅ 資料庫初始化完成")
    yield
    # === Shutdown ===
    logger.info("🔄 正在關閉...")
    llama_process_manager.stop_all()
    logger.info("👋 LLM Server Router 已關閉")


app = FastAPI(
    title="LLM Server Router",
    description="本地 LLM 路由管理系統 - 針對 AMD Radeon 890M (Strix Point) 優化",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS 設定 (開發階段允許所有來源，之後須限縮)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 掛載路由
app.include_router(model_routes.router)
app.include_router(settings_routes.router)
app.include_router(process_routes.router)
app.include_router(benchmark_routes.router)
app.include_router(openai_router.router)


@app.get("/")
def root():
    """健康檢查端點。"""
    return {
        "service": "LLM Server Router",
        "version": "0.1.0",
        "status": "running",
    }


@app.get("/api/status")
def get_server_status():
    """取得 llama-server 進程狀態。"""
    return llama_process_manager.get_status()
