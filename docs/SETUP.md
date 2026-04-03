# LLM Server Router - 安裝與使用手冊

## 目錄

- [系統需求](#系統需求)
- [快速開始](#快速開始)
- [環境設定](#環境設定)
- [啟動服務](#啟動服務)
- [API 使用指南](#api-使用指南)
- [遠端裝置連線](#遠端裝置連線)
- [常見問題](#常見問題)

---

## 系統需求

| 項目 | 需求 |
|---|---|
| OS | Linux (Ubuntu 22.04+ 推薦) |
| Python | 3.10+ |
| Node.js | 18+ (前端) |
| GPU | AMD Radeon 890M 或其他支援 ROCm/Vulkan 的 GPU |
| RAM | 建議 16GB 以上（統一記憶體環境可充分利用） |
| llama.cpp | 需自備編譯好的 `llama-server` 與 `llama-bench` 二進位檔（ROCm 或 Vulkan 版本） |

### 預置軟體

```bash
# 確認 Python 版本
python3 --version  # >= 3.10

# 安裝 uv (如果尚未安裝)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

---

## 快速開始

### 1. 克隆專案

```bash
git clone git@github.com:Starlee-0514/LLM_Server_Router.git
cd LLM_Server_Router
```

### 2. 環境設定

```bash
# 複製範例環境變數檔案
cp .env.example .env

# 編輯 .env 填入實際路徑
nano .env  # 或使用任何編輯器
```

### 3. 安裝依賴

```bash
# 後端
uv sync

# 前端
cd frontend && npm install && cd ..
```

### 4. 啟動服務

```bash
# 終端 1：後端（開發模式，附帶自動重載）
uv run uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000

# 終端 2：前端
cd frontend && npm run dev
```

### 5. 驗證

- **前端儀表板**：`http://localhost:3000`
- **API 文件 (Swagger)**：`http://localhost:8000/docs`

---

## 環境設定

### `.env` 檔案說明

| 變數 | 說明 | 預設值 |
|---|---|---|
| `LLAMA_ROCM_PATH` | ROCm 版 llama-server 的完整路徑 | `/usr/local/bin/llama-server` |
| `LLAMA_VULKAN_PATH` | Vulkan 版 llama-server 的完整路徑 | `/usr/local/bin/llama-server-vulkan` |
| `HSA_OVERRIDE_GFX_VERSION` | AMD GPU 架構覆寫（Strix Point 需要） | `11.5.0` |
| `LLAMA_SERVER_PORT` | llama-server 監聽的內部埠號 | `8081` |
| `OPENAI_API_KEY` | OpenAI API Key（用於 fallback） | _(空白)_ |
| `ANTHROPIC_API_KEY` | Anthropic API Key（用於 fallback） | _(空白)_ |
| `DATABASE_URL` | SQLite 資料庫路徑 | `sqlite:///./llm_router.db` |

### 範例 `.env`

```env
LLAMA_ROCM_PATH=/home/starlee/llama.cpp/build-rocm/bin/llama-server
LLAMA_VULKAN_PATH=/home/starlee/llama.cpp/build-vulkan/bin/llama-server
HSA_OVERRIDE_GFX_VERSION=11.5.0
LLAMA_SERVER_PORT=8081
OPENAI_API_KEY=sk-xxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxx
DATABASE_URL=sqlite:///./llm_router.db
```

---

## 啟動服務

### 開發模式

```bash
uv run uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

- `--reload`：檔案變更時自動重啟
- `--host 0.0.0.0`：接受所有網路介面的連線（供遠端裝置存取）
- `--port 8000`：API Router 監聽埠號

### 生產模式

```bash
uv run uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

> **注意**：由於進程管理器使用全域單例，建議 `--workers 1`。多 worker 模式需要改用行程間通訊(IPC)的機制。

### 服務啟動後的自動行為

1. SQLite 資料庫自動建立（如果不存在）
2. 所有資料表自動初始化 (`settings`, `model_groups`, `benchmark_records`)
3. 應用程式關閉時，自動停止正在運行的 llama-server 進程

---

## API 使用指南

啟動後，完整的互動式 API 文件可在 `http://localhost:8000/docs` (Swagger UI) 查閱。

### 系統狀態

```bash
# 健康檢查
curl http://localhost:8000/

# llama-server 進程狀態
curl http://localhost:8000/api/status
```

### 設定管理

```bash
# 取得所有設定
curl http://localhost:8000/api/settings

# 設定模型掃描目錄（JSON 陣列格式的值）
curl -X PUT http://localhost:8000/api/settings \
  -H "Content-Type: application/json" \
  -d '{
    "settings": [
      {
        "key": "model_scan_dirs",
        "value": "[\"/home/starlee/models\", \"/mnt/storage/gguf\"]"
      }
    ]
  }'

# 取得特定設定
curl http://localhost:8000/api/settings/model_scan_dirs
```

### 模型掃描

```bash
# 掃描已設定的目錄
curl http://localhost:8000/api/models/scan

# 掃描指定的目錄（一次性，不修改設定）
curl -X POST http://localhost:8000/api/models/scan \
  -H "Content-Type: application/json" \
  -d '{"directories": ["/home/starlee/models"]}'
```

回應範例：

```json
{
  "total_count": 3,
  "scanned_directories": ["/home/starlee/models"],
  "models": [
    {
      "filename": "Qwen3.5-9B-Q4_K_M.gguf",
      "filepath": "/home/starlee/models/lmstudio-community/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf",
      "size_bytes": 5610000000,
      "size_human": "5.23 GB",
      "parent_dir": "/home/starlee/models/lmstudio-community/Qwen3.5-9B-GGUF",
      "publisher": "lmstudio-community",
      "quantize": "Q4_K_M",
      "param_size": "9B",
      "arch": "Qwen3.5"
    }
  ],
  "errors": []
}
```

---

## 遠端裝置連線

本系統設計為可從任何支援 OpenAI API 格式的客戶端連線使用。

### 同一區域網路

1. 確認啟動時使用 `--host 0.0.0.0`
2. 查詢機器的區域網路 IP：
   ```bash
   ip addr show | grep "inet " | grep -v 127.0.0.1
   ```
3. 從其他裝置連線：`http://<YOUR_IP>:8000`

### 透過 SSH Tunnel（安全的遠端存取）

```bash
# 在遠端裝置上執行
ssh -L 8000:localhost:8000 user@your-server-ip
# 然後在遠端裝置上存取 http://localhost:8000
```

### 透過 Reverse Proxy（對外服務）

使用 Caddy 的範例：

```
llm.yourdomain.com {
    reverse_proxy localhost:8000
}
```

### IDE / 工具整合

在支援 OpenAI API 的工具中設定（API Router 完成後可用）：

| 工具 | 設定欄位 | 值 |
|---|---|---|
| Continue.dev | API Base URL | `http://<IP>:8000/v1` |
| Cursor | OpenAI Base URL | `http://<IP>:8000/v1` |
| Open WebUI | OpenAI API URL | `http://<IP>:8000/v1` |

---

## 常見問題

### Q: 啟動時出現 `HSA_OVERRIDE_GFX_VERSION` 相關錯誤

確認 `.env` 中已設定 `HSA_OVERRIDE_GFX_VERSION=11.5.0`，此為 AMD Strix Point 架構所需的覆寫值。

### Q: llama-server 啟動失敗

1. 確認 `.env` 中的路徑指向正確的 llama-server 二進位檔
2. 確認該檔案有執行權限：`chmod +x /path/to/llama-server`
3. 手動測試是否能啟動：`/path/to/llama-server --help`

### Q: 掃描不到 GGUF 模型

1. 確認已透過 `PUT /api/settings` 設定 `model_scan_dirs`
2. 確認目錄路徑存在且有讀取權限
3. 確認檔案副檔名為 `.gguf`（區分大小寫）

### Q: 資料庫相關問題

```bash
# 完全重建資料庫（會清除所有設定與紀錄）
rm llm_router.db
# 重新啟動服務即可自動建立
```
