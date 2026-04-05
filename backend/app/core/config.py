"""
應用程式設定 - 從 .env 檔案載入環境變數
"""
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """應用程式全域設定，從 .env 檔案與環境變數載入。"""

    # === llama.cpp 二進位檔案路徑 ===
    llama_rocm_path: str = "/usr/local/bin/llama-server"
    llama_vulkan_path: str = "/usr/local/bin/llama-server-vulkan"

    # === AMD GPU 環境變數 ===
    hsa_override_gfx_version: str = "11.5.0"

    # === llama-server 預設設定 ===
    llama_server_port: int = 8081

    # === 遠端 API 金鑰 (fallback) ===
    openai_api_key: str = ""
    anthropic_api_key: str = ""

    # === OAuth Client 設定 ===
    github_client_id: str = ""
    github_client_secret: str = ""
    google_client_id: str = ""
    google_client_secret: str = ""

    # === 資料庫 ===
    database_url: str = "sqlite:///./llm_router.db"

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": False,
    }


# 全域單例
settings = Settings()
