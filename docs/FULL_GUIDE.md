# LLM Server Router — 完整使用指南

> **一句話介紹**：LLM Server Router 是一個跑在你本機的 **AI 模型管理中心**，讓你可以一鍵啟動本地模型、自動效能測試、並且對外提供一個統一的 OpenAI 格式 API — 當本地模型忙不過來時，自動切換到雲端 API（OpenAI / Anthropic / GitHub Copilot / Gemini）。

---

## 目錄

- [誰適合用這個專案？](#誰適合用這個專案)
- [核心概念懶人包](#核心概念懶人包)
- [系統架構總覽](#系統架構總覽)
  - [後端架構](#後端架構)
  - [前端架構](#前端架構)
  - [資料庫結構](#資料庫結構)
- [安裝與環境設定](#安裝與環境設定)
- [啟動服務](#啟動服務)
- [前端頁面使用教學](#前端頁面使用教學)
- [API 完整參考手冊](#api-完整參考手冊)
- [進階功能](#進階功能)
  - [Tailscale Mesh 多節點路由](#tailscale-mesh-多節點路由)
  - [Virtual Model 虛擬模型](#virtual-model-虛擬模型)
  - [Tool Calling 工具呼叫](#tool-calling-工具呼叫)
  - [路由策略](#路由策略)
- [與外部工具整合](#與外部工具整合)
- [常見問題 FAQ](#常見問題-faq)
- [專案結構速查表](#專案結構速查表)
- [技術棧一覽](#技術棧一覽)

---

## 誰適合用這個專案？

| 你的需求 | 這個專案能幫你 |
|---------|--------------|
| 我有一台 AMD GPU 的主機，想跑本地模型 | ✅ 自動管理 llama-server 進程，支援 ROCm / Vulkan |
| 我想讓筆電 / 手機也能用我桌機的本地模型 | ✅ 暴露 OpenAI 格式 API，區網內直接連線 |
| 我想在 Cursor / VS Code / Continue.dev 用本地模型 | ✅ 完全相容 OpenAI API，直接填入 Base URL 即可 |
| 本地模型不夠用時想自動切換到雲端 | ✅ 內建 Fallback：本地 → Mesh → 雲端 API |
| 我想比較不同量化版本的模型效能 | ✅ 內建 llama-bench 整合，一鍵跑分 |
| 我想把多台電腦的 GPU 串起來用 | ✅ Tailscale Mesh 支援多節點路由 |

---

## 核心概念懶人包

開始之前，先了解幾個核心概念：

### 🔑 什麼是 GGUF？

GGUF 是 `llama.cpp` 使用的模型格式。你可以從 [HuggingFace](https://huggingface.co/) 下載各種 `.gguf` 模型檔（例如 `Qwen3.5-9B-Q4_K_M.gguf`）。檔名通常包含：

| 部分 | 意義 | 範例 |
|-----|------|-----|
| 架構名 | 模型基底 | Qwen3.5, Llama-3.1, Phi-4 |
| 參數量 | 模型大小 | 7B, 9B, 70B |
| 量化格式 | 壓縮方式（越大品質越好、越佔記憶體） | Q4_K_M, Q5_K_S, Q8_0, F16 |

### 🔑 什麼是 llama-server / llama-bench？

- **llama-server**：`llama.cpp` 提供的推理伺服器，載入一個 GGUF 模型後對外提供 API。
- **llama-bench**：效能測試工具，測量模型的推理速度（tokens/sec）。

### 🔑 什麼是 Runtime？

Runtime = 你編譯好的 `llama.cpp` 執行環境。因為 AMD GPU 可以用 ROCm 或 Vulkan 編譯，所以系統允許你定義多種 Runtime，每種指向不同的執行檔和環境變數。

### 🔑 什麼是 Model Group？

Model Group = 一組預設好的啟動參數。把「模型路徑 + GPU Layers + Batch Size + Context Size + Runtime」打包成一個群組，下次一鍵就能啟動，不用每次重新設定。

### 🔑 什麼是路由 (Routing)？

當外部工具（如 Cursor）發送請求 `model: "gpt-4o"` 到本系統時，路由決定這個請求要送去哪裡：
1. **本地 llama-server** — 如果你有正在運行的本地模型
2. **Mesh Worker** — 如果你的另一台電腦有這個模型在跑
3. **雲端 Provider** — OpenAI / Anthropic / GitHub Copilot / Gemini

---

## 系統架構總覽

```
┌─────────────────────────────────────────────────────────────────┐
│                    外部客戶端 (External Clients)                  │
│  Cursor / VS Code / Continue.dev / Open WebUI / 手機 App / curl  │
└─────────────────────────┬───────────────────────────────────────┘
                          │ HTTP (OpenAI 格式)
                          │ POST /v1/chat/completions
                          │ GET  /v1/models
┌─────────────────────────▼───────────────────────────────────────┐
│                     Next.js 前端 (Port 3000)                      │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────────┐   │
│  │Dashboard │ Models   │Benchmark │Inference │ Settings     │   │
│  │ 儀表板   │ 模型管理 │ 效能測試 │ 推理測試 │ 系統設定     │   │
│  ├──────────┼──────────┼──────────┼──────────┼──────────────┤   │
│  │Providers │ Routes   │ Mapping  │ Mesh     │ Reports/Dev  │   │
│  │ 供應商   │ 路由規則 │ 模型對映 │ 節點網格 │ 報告/除錯    │   │
│  └──────────┴──────────┴──────────┴──────────┴──────────────┘   │
└─────────────────────────┬───────────────────────────────────────┘
                          │ HTTP REST API
┌─────────────────────────▼───────────────────────────────────────┐
│                    FastAPI 後端 (Port 8000)                        │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  API 路由層 (Routers)                         │ │
│  │  /v1/*           OpenAI 相容路由 (chat/completions, models) │ │
│  │  /api/models/*   模型掃描 & 屬性覆寫                         │ │
│  │  /api/model-groups/*  模型群組 CRUD                          │ │
│  │  /api/process/*  進程啟動 / 停止 / 狀態                     │ │
│  │  /api/benchmarks/*  效能測試執行 & 歷史                     │ │
│  │  /api/providers/*  Provider 端點 CRUD + OAuth               │ │
│  │  /api/model-routes/*  路由規則 CRUD                         │ │
│  │  /api/mesh/*     Mesh Worker 管理                            │ │
│  │  /api/runtimes/* Runtime 環境 CRUD                          │ │
│  │  /api/settings   系統設定 KV                                 │ │
│  │  /api/metrics/*  系統指標 & 請求統計                         │ │
│  │  /api/reports/*  Bug Report 管理                             │ │
│  │  /api/dev/*      開發除錯 (event log, process detail)       │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌───────────────┐  ┌───────────────┐  ┌────────────────────┐   │
│  │ ProcessManager│  │ RouteResolver │  │ BenchmarkRunner    │   │
│  │ 進程管理器    │  │ 路由解析器    │  │ 效能測試執行器     │   │
│  │               │  │               │  │                    │   │
│  │ · 啟動/停止   │  │ · 本地優先    │  │ · 非同步 SSE 串流 │   │
│  │ · Port 分配   │  │ · 能力篩選    │  │ · 結果解析入庫    │   │
│  │ · 自動清理    │  │ · 策略評分    │  │                    │   │
│  └───────┬───────┘  └───────┬───────┘  └────────┬───────────┘   │
│          │                  │                    │               │
│  ┌───────▼──────────────────▼────────────────────▼───────────┐   │
│  │                    SQLite Database                          │   │
│  │  settings · runtimes · model_groups · benchmark_records    │   │
│  │  provider_endpoints · model_routes · mesh_workers          │   │
│  │  model_property_overrides · completion_logs                │   │
│  │  virtual_models                                            │   │
│  └────────────────────────────────────────────────────────────┘   │
└────────────────────┬────────────────────────┬───────────────────┘
                     │                        │
          ┌──────────▼──────────┐   ┌─────────▼─────────┐
          │  本地 llama-server  │   │   遠端 API 供應商  │
          │  (ROCm / Vulkan)    │   │  OpenAI · Anthropic│
          │  Port 8081, 8082... │   │  Copilot · Gemini  │
          └─────────────────────┘   └───────────────────┘
```

### 後端架構

後端使用 **Python FastAPI** 框架，以下是各模組職責：

| 模組 | 路徑 | 職責 |
|-----|------|------|
| **main.py** | `backend/app/main.py` | FastAPI 應用進入點、生命週期管理、CORS、API Token 中間件 |
| **config.py** | `backend/app/core/config.py` | 從 `.env` 載入全域設定（Pydantic Settings） |
| **database.py** | `backend/app/database.py` | SQLAlchemy Engine / Session / 自動 Migration |
| **models.py** | `backend/app/models.py` | 10 張 ORM 資料表定義 |
| **schemas.py** | `backend/app/schemas.py` | Pydantic 請求 / 回應模型 |
| **process_manager.py** | `backend/app/core/process_manager.py` | llama-server 進程生命週期（啟動、停止、port 分配、stderr 監控、phase 偵測） |
| **runtime_settings.py** | `backend/app/core/runtime_settings.py` | DB-backed 設定讀取、Runtime 環境解析 |
| **model_scanner.py** | `backend/app/services/model_scanner.py` | 遞迴掃描 `.gguf` 檔案、解析 metadata（publisher, quantize, param_size, arch）、mmproj 關聯 |
| **benchmark_runner.py** | `backend/app/services/benchmark_runner.py` | 非同步執行 llama-bench、SSE 串流 log、解析 t/s 結果 |
| **route_resolver.py** | `backend/app/services/route_resolver.py` | 多來源候選收集 → 能力篩選 → 策略評分排序 |
| **tool_normalizer.py** | `backend/app/services/tool_normalizer.py` | OpenAI ↔ Anthropic tool schema 轉換、參數驗證、迴圈保護 |
| **mesh_health.py** | `backend/app/services/mesh_health.py` | 背景 Health-Check 任務（30s 週期探測 Mesh Worker） |
| **system_metrics.py** | `backend/app/services/system_metrics.py` | Linux sysfs 讀取 CPU/GPU/RAM 指標 |

#### 路由層一覽

| Router 檔案 | 端點前綴 | 功能 |
|------------|---------|------|
| `openai_router.py` | `/v1/*` | OpenAI 相容的 Chat Completions & Models 端點 |
| `model_routes.py` | `/api/models/*` | GGUF 模型掃描、屬性覆寫 |
| `model_group_routes.py` | `/api/model-groups/*` | 模型群組 CRUD + 一鍵啟動 |
| `process_routes.py` | `/api/process/*` | llama-server 進程控制 |
| `benchmark_routes.py` | `/api/benchmarks/*` | 效能測試（SSE 串流） |
| `settings_routes.py` | `/api/settings` | 系統設定 KV store |
| `runtime_routes.py` | `/api/runtimes/*` | Runtime 環境 CRUD |
| `provider_routes.py` | `/api/providers/*` `/api/model-routes/*` `/api/mesh/*` | Provider 端點、路由規則、Mesh Worker、OAuth |
| `metrics_routes.py` | `/api/metrics/*` | 系統指標、請求統計、最近 Benchmark |
| `report_routes.py` | `/api/reports/*` | Bug Report CRUD |
| `dev_routes.py` | `/api/dev/*` | 開發除錯工具 |
| `virtual_model_routes.py` | `/api/virtual-models/*` | Virtual Model CRUD |

### 前端架構

前端使用 **Next.js 16 + React 19 + Tailwind CSS 4 + Shadcn/UI**。

| 頁面 | 路徑 | 功能 |
|-----|------|------|
| **Dashboard** | `/` | 系統總覽：後端狀態、Active Models、GPU/RAM 使用率、API 請求統計、最近 Benchmark |
| **Models** | `/models` | 雙欄佈局：左欄掃描到的 GGUF 檔案、右欄模型群組管理，支援一鍵啟動 / 編輯 / 刪除 |
| **Inference** | `/inference` | 線上聊天測試介面，選擇模型後即時對話（支援 streaming） |
| **Benchmarks** | `/benchmarks` | 選擇模型 → 設定參數 → 執行 llama-bench → 即時 Log + 結果表格 |
| **Providers** | `/providers` | 管理遠端 API 供應商（OpenAI, Anthropic, Copilot, Gemini 等） |
| **Routes** | `/routes` | 管理模型路由規則：model name → Provider 對映 |
| **Mapping** | `/mapping` | 模型屬性覆寫、Model Family 分類 |
| **Mesh** | `/mesh` | Tailscale Mesh Worker 節點管理 |
| **Reports** | `/reports` | Bug Report 提交與查看 |
| **Dev** | `/dev` | 開發除錯：進程事件日誌、即時 Log 串流 |
| **Settings** | `/settings` | 系統設定：掃描目錄、Runtime 設定、API Key 管理 |

### 資料庫結構

使用 **SQLite** + **SQLAlchemy ORM**，資料庫檔案為 `llm_router.db`（根目錄），啟動時自動建立。

| 資料表 | 用途 |
|-------|------|
| `settings` | 系統設定鍵值表（model_scan_dirs, api_token, ...） |
| `runtimes` | Runtime 環境定義（名稱、執行檔路徑、環境變數） |
| `model_groups` | 模型群組預設（啟動參數打包） |
| `benchmark_records` | llama-bench 測試結果 |
| `provider_endpoints` | 遠端 API 供應商端點 |
| `model_routes` | 模型名稱 → Provider 路由規則 |
| `model_property_overrides` | 使用者自訂模型屬性覆寫 |
| `mesh_workers` | Tailscale Mesh 節點註冊表 |
| `completion_logs` | 每次 /v1/chat/completions 請求記錄 |
| `virtual_models` | 虛擬模型別名 |

---

## 安裝與環境設定

### 前置要求

| 項目 | 要求 |
|-----|------|
| **作業系統** | Linux（推薦 Ubuntu 22.04+） |
| **Python** | 3.10 以上 |
| **Node.js** | 18 以上 |
| **GPU** | AMD Radeon 890M（或其他支援 ROCm/Vulkan 的 GPU） |
| **RAM** | 建議 16GB+（統一記憶體環境更佳） |
| **llama.cpp** | 需自行編譯 `llama-server` 與 `llama-bench`（ROCm 或 Vulkan 版本） |

### Step 1: 克隆專案

```bash
git clone git@github.com:Starlee-0514/LLM_Server_Router.git
cd LLM_Server_Router
```

### Step 2: 設定環境變數

```bash
cp .env.example .env
nano .env   # 編輯以下欄位
```

**.env 參數說明：**

| 變數 | 說明 | 範例 |
|-----|------|-----|
| `LLAMA_ROCM_PATH` | ROCm 版 llama-server 的路徑 | `/home/user/llama.cpp/build-rocm/bin/llama-server` |
| `LLAMA_VULKAN_PATH` | Vulkan 版 llama-server 的路徑 | `/home/user/llama.cpp/build-vulkan/bin/llama-server` |
| `HSA_OVERRIDE_GFX_VERSION` | AMD GPU 架構覆寫（Strix Point = 11.5.0） | `11.5.0` |
| `LLAMA_SERVER_PORT` | llama-server 起始監聽 Port | `8081` |
| `OPENAI_API_KEY` | OpenAI API Key（選填，用於 fallback） | `sk-...` |
| `ANTHROPIC_API_KEY` | Anthropic API Key（選填） | `sk-ant-...` |
| `DATABASE_URL` | SQLite 路徑 | `sqlite:///./llm_router.db` |

### Step 3: 安裝依賴

```bash
# 安裝 uv（如未安裝）
curl -LsSf https://astral.sh/uv/install.sh | sh

# 後端 Python 依賴
uv sync

# 前端 Node.js 依賴
cd frontend && npm install && cd ..
```

### Step 4: 下載 GGUF 模型

從 HuggingFace 下載模型檔到你想要的目錄，例如：

```bash
mkdir -p ~/models
# 使用 huggingface-cli 或直接瀏覽器下載
# 範例：Qwen3.5-9B-Q4_K_M.gguf
```

---

## 啟動服務

### 開發模式（推薦）

開兩個終端視窗：

```bash
# 終端 1：後端
uv run uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000

# 終端 2：前端
cd frontend && npm run dev
```

### 驗證

| 服務 | 網址 |
|-----|------|
| 前端介面 | http://localhost:3000 |
| API 文件 (Swagger) | http://localhost:8000/docs |
| 健康檢查 | http://localhost:8000/ |

### 啟動後自動發生的事

1. SQLite 資料庫自動建立（若不存在）
2. 所有資料表自動初始化
3. 預設 `rocm` 和 `vulkan` 兩個 Runtime 自動建立
4. Mesh Worker 背景 Health-Check 任務啟動（每 30 秒）
5. 關閉時自動停止所有 llama-server 進程

---

## 前端頁面使用教學

### 1️⃣ Dashboard — 系統總覽

打開 `http://localhost:3000`，你會看到：
- **Backend Status**：後端連線狀態
- **Active Models**：正在運行的模型數量
- **GPU Usage**：AMD GPU 使用率 + VRAM
- **Memory Usage**：系統 RAM
- **API Requests Today**：今日 API 請求數（Local vs Remote 比例）
- **Recent Benchmarks**：最近的效能測試結果
- **Running Processes**：運行中的 llama-server 清單（PID, Engine, Port, Uptime）

### 2️⃣ Models — 模型管理

**第一次使用？先設定掃描目錄：**

1. 進入 **Settings** 頁面
2. 設定 `model_scan_dirs` 為你的 GGUF 模型目錄（JSON 陣列格式）：`["/home/user/models"]`
3. 回到 **Models** 頁面，點選 **Scan** 按鈕

**左欄：已掃描的檔案**
- 顯示所有掃描到的 `.gguf` 檔案
- 自動解析：Publisher、Quantize、Param Size、Architecture
- 支援搜尋與篩選

**右欄：模型群組**
- 點選左欄的檔案 → 建立 Model Group（預設參數）
- 設定：GPU Layers、Batch Size、Context Size、Runtime
- 點選 **Launch** → 一鍵啟動 llama-server
- 支援編輯、刪除

### 3️⃣ Inference — 推理測試

1. 從下拉選單選擇一個模型（本地運行中 / Provider 路由的都會出現）
2. 在對話框輸入訊息
3. 支援 streaming，即時顯示回應
4. 可調整 temperature、max_tokens、top_p

### 4️⃣ Benchmarks — 效能測試

1. 選擇要測試的模型（GGUF 檔案路徑）
2. 設定測試參數：
   - **Batch sizes**：逗號分隔（如 `128,256,512`）
   - **GPU Layers**：逗號分隔（如 `999`）
   - **Prompt Tokens (pp)**：提示處理的 token 數
   - **Generation Tokens (tg)**：生成的 token 數
   - **Flash Attention**：開 / 關
   - **KV Offload**：開 / 關
3. 點選 **Run** → 即時看到 debug log（串流輸出）
4. 完成後結果自動存入資料庫，表格會顯示 pp t/s 和 tg t/s
5. 支援 **Export JSON**（備份）和 **Import JSON**（跨裝置比較）

### 5️⃣ Providers — 供應商管理

管理你可用的遠端 API：

| 類型 | 支援 |
|-----|------|
| OpenAI | API Key 認證 |
| Anthropic | API Key 認證 |
| GitHub Copilot | Device Code OAuth 流程 |
| GitHub Models | Device Code OAuth 流程 |
| Google Gemini CLI | Google OAuth (PKCE) 流程 |
| 任何 OpenAI 相容 API | 自訂 Base URL + API Key |

點選 **Add Provider** → 填入資訊 → 系統自動健康檢查。

### 6️⃣ Routes — 路由規則

定義「當請求某個 model name 時，轉發到哪個 Provider」：

- **Match Type**: `exact`（完全匹配）或 `prefix`（前綴匹配）
- **Match Value**: 要匹配的模型名稱（如 `gpt-4o`）
- **Target Model**: 轉發給 Provider 時用的模型名稱
- **Provider**: 目標供應商
- **Priority**: 數字越小優先級越高

### 7️⃣ Settings — 系統設定

| 設定 Key | 說明 |
|---------|------|
| `model_scan_dirs` | GGUF 掃描目錄（JSON 陣列） |
| `default_engine` | 預設 Runtime（rocm / vulkan） |
| `api_token` | API Token 保護（設定後 /v1/* 需要 Bearer Token） |

---

## API 完整參考手冊

> 💡 啟動後在 `http://localhost:8000/docs` 可看到互動式 Swagger 文件。

### OpenAI 相容端點

```bash
# 列出可用模型
curl http://localhost:8000/v1/models

# 發送 Chat Completion（非串流）
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3.5-9B-Q4_K_M",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# 串流模式
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3.5-9B-Q4_K_M",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# 指定路由策略
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Route-Policy: fastest" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hi"}]}'
```

### 核心 API

```bash
# ─── 健康 & 狀態 ───
GET  /                          # 健康檢查
GET  /api/status                # 所有 llama-server 狀態

# ─── 模型掃描 ───
GET  /api/models/scan           # 掃描已設定的目錄
POST /api/models/scan           # 掃描指定目錄 {"directories": [...]}

# ─── 模型群組 ───
GET    /api/model-groups        # 列出所有群組
POST   /api/model-groups        # 建立群組
PUT    /api/model-groups/{id}   # 更新群組
DELETE /api/model-groups/{id}   # 刪除群組
POST   /api/model-groups/{id}/launch  # 一鍵啟動

# ─── 進程控制 ───
POST /api/process/start         # 啟動 llama-server
POST /api/process/stop/{id}     # 停止
GET  /api/process/status        # 所有進程狀態

# ─── 效能測試 ───
POST /api/benchmarks/run        # 執行測試（SSE 串流）
GET  /api/benchmarks/history    # 歷史紀錄
POST /api/benchmarks/import     # 匯入紀錄
DELETE /api/benchmarks/{id}     # 刪除紀錄

# ─── 設定 ───
GET  /api/settings              # 取得所有設定
PUT  /api/settings              # 批次更新

# ─── Runtime ───
GET    /api/runtimes            # 列出所有 runtime
POST   /api/runtimes            # 建立
PUT    /api/runtimes/{id}       # 更新
DELETE /api/runtimes/{id}       # 刪除

# ─── Provider ───
GET    /api/providers                    # 列出
POST   /api/providers                    # 建立
PUT    /api/providers/{id}               # 更新
DELETE /api/providers/{id}               # 刪除
GET    /api/providers/{id}/health        # 健康檢查
GET    /api/providers/{id}/models        # 列出 Provider 模型
GET    /api/providers/common/templates   # 常用 Provider 模板

# ─── 路由規則 ───
GET    /api/model-routes        # 列出
POST   /api/model-routes        # 建立
PUT    /api/model-routes/{id}   # 更新
DELETE /api/model-routes/{id}   # 刪除

# ─── Mesh ───
GET  /api/mesh/workers                   # 列出節點
POST /api/mesh/workers/heartbeat         # 註冊 / 心跳
DELETE /api/mesh/workers/{id}            # 移除節點

# ─── 指標 ───
GET /api/metrics/requests       # 今日請求統計
GET /api/metrics/system         # GPU / RAM 指標
GET /api/metrics/benchmarks/recent  # 最近 Benchmark
```

---

## 進階功能

### Tailscale Mesh 多節點路由

把多台電腦用 Tailscale VPN 連起來，形成一個模型叢集：

**架構：**
- **Hub 節點**：跑 LLM Server Router，對外只暴露一個端點
- **Worker 節點**：跑任何 OpenAI 相容框架（llama.cpp, vLLM, SGLang...）

**設定步驟：**

```bash
# 1. 在 Hub 上註冊 Worker Provider
curl -X POST http://hub:8000/api/providers \
  -H "Content-Type: application/json" \
  -d '{"name":"worker-a","provider_type":"openai_compatible","base_url":"http://worker-a:8000","enabled":true}'

# 2. 建立路由規則
curl -X POST http://hub:8000/api/model-routes \
  -H "Content-Type: application/json" \
  -d '{"route_name":"qwen","match_type":"prefix","match_value":"qwen","target_model":"Qwen3.5-9B","provider_id":1,"priority":10,"enabled":true}'

# 3. Worker 定期發送心跳（可選，也可由 Hub 主動探測）
curl -X POST http://hub:8000/api/mesh/workers/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"node_name":"worker-a","base_url":"http://worker-a:8000","models":["Qwen3.5-9B"],"status":"online"}'
```

Hub 會自動每 30 秒健康檢查，狀態轉換：`online → stale（2次失敗）→ offline（5次失敗）→ online（恢復）`

### 路由策略

通過 `X-Route-Policy` Header 或 Virtual Model 的 routing_hints 設定：

| 策略 | 行為 |
|-----|------|
| `local_first`（預設）| 優先本地 → Mesh → 雲端 |
| `local_only` | 只用本地模型 |
| `remote_only` | 只用遠端 |
| `fastest` | 選擇 benchmark 最快的 |
| `cheapest` | 優先免費的（本地 → Mesh → OpenAI → Anthropic） |
| `highest_quality` | 優先品質（Anthropic → OpenAI → Mesh → 本地） |

### Virtual Model 虛擬模型

建立穩定的邏輯模型 ID，不管底層用什麼模型：

```bash
curl -X POST http://localhost:8000/api/virtual-models \
  -H "Content-Type: application/json" \
  -d '{
    "model_id": "coding",
    "display_name": "Best coding model",
    "routing_hints": {"preferred_policy": "fastest", "requires_tools": true}
  }'
```

外部工具只需指定 `model: "coding"`，Router 自動選最佳後端。

### Tool Calling 工具呼叫

系統自動處理 OpenAI 格式的 tool calling：
- **OpenAI / OpenAI 相容 Provider**：直接透傳
- **Anthropic Provider**：自動轉換 tools schema
- **參數驗證**：自動檢查 model 返回的參數是否符合 schema
- **迴圈保護**：默認最多 10 次 tool call 迴圈

---

## 與外部工具整合

### Cursor

1. Settings → Models → OpenAI API Key: 任意填
2. API Base URL: `http://<你的IP>:8000/v1`

### Continue.dev (VS Code)

```json
// ~/.continue/config.json
{
  "models": [{
    "title": "Local Router",
    "provider": "openai",
    "model": "Qwen3.5-9B-Q4_K_M",
    "apiBase": "http://<你的IP>:8000/v1",
    "apiKey": "any"
  }]
}
```

### Open WebUI

Settings → OpenAI API URL: `http://<你的IP>:8000/v1`

### 透過 SSH Tunnel 遠端存取

```bash
ssh -L 8000:localhost:8000 user@your-server-ip
# 然後在本地存取 http://localhost:8000
```

---

## 常見問題 FAQ

### Q: `HSA_OVERRIDE_GFX_VERSION` 相關錯誤

確認 `.env` 中已設定 `HSA_OVERRIDE_GFX_VERSION=11.5.0`。這是 AMD Strix Point 架構所需的覆寫值。

### Q: llama-server 啟動失敗

1. 確認 `.env` 路徑指向正確的二進位檔
2. 確認有執行權限：`chmod +x /path/to/llama-server`
3. 手動測試：`/path/to/llama-server --help`
4. 查看 **Dev** 頁面的進程日誌，通常會有具體錯誤

### Q: 掃描不到模型

1. 確認 Settings 裡 `model_scan_dirs` 已設定
2. 確認目錄存在且有讀取權限
3. 確認檔案副檔名為 `.gguf`（區分大小寫）

### Q: 重置資料庫

```bash
rm llm_router.db llm_router.db-shm llm_router.db-wal
# 重新啟動服務即可自動建立
```

### Q: 前端無法連線後端

前端預設使用 `http://<當前頁面hostname>:8000` 作為 API 位址。如果後端在不同的主機/Port，設定環境變數 `NEXT_PUBLIC_API_URL`。

### Q: 如何保護 API？

在 Settings 中設定 `api_token`，設定後所有 `/v1/*` 端點都需要 `Authorization: Bearer <token>` 或 `X-API-Key: <token>` Header。

---

## 專案結構速查表

```
LLM_Server_Router/
├── backend/
│   ├── __init__.py
│   └── app/
│       ├── main.py                        # FastAPI 進入點
│       ├── models.py                      # 10 張 ORM 資料表
│       ├── schemas.py                     # Pydantic schemas
│       ├── database.py                    # DB Engine + Migration
│       ├── core/
│       │   ├── config.py                  # .env 設定載入
│       │   ├── process_manager.py         # llama-server 進程管理
│       │   ├── runtime_settings.py        # DB 設定讀取 + Runtime 解析
│       │   ├── dev_logs.py                # 開發日誌（ring buffer）
│       │   ├── request_stats.py           # 請求計數器
│       │   └── provider_helpers.py        # Provider headers 工具
│       ├── services/
│       │   ├── model_scanner.py           # GGUF 檔案掃描 + metadata 解析
│       │   ├── benchmark_runner.py        # llama-bench 非同步執行
│       │   ├── route_resolver.py          # 路由候選評分排序
│       │   ├── tool_normalizer.py         # Tool calling 格式轉換
│       │   ├── mesh_health.py             # Mesh Worker 健康檢查
│       │   ├── system_metrics.py          # GPU/RAM 指標
│       │   └── adapters/
│       │       ├── base.py                # Provider adapter 基類
│       │       ├── openai_adapter.py      # OpenAI 適配器
│       │       └── anthropic_adapter.py   # Anthropic 適配器
│       └── api/routers/
│           ├── openai_router.py           # /v1/* (1050 行，核心路由邏輯)
│           ├── provider_routes.py         # Provider + 路由規則 + Mesh + OAuth
│           ├── model_routes.py            # 模型掃描 + 屬性覆寫
│           ├── model_group_routes.py      # 模型群組 CRUD
│           ├── process_routes.py          # 進程控制
│           ├── benchmark_routes.py        # Benchmark 執行 & 歷史
│           ├── settings_routes.py         # 系統設定
│           ├── runtime_routes.py          # Runtime CRUD
│           ├── metrics_routes.py          # 指標 API
│           ├── report_routes.py           # Bug Reports
│           ├── dev_routes.py              # 開發工具
│           └── virtual_model_routes.py    # Virtual Models
├── frontend/
│   ├── package.json                       # Node.js 依賴
│   ├── next.config.ts                     # Next.js 設定
│   └── src/
│       ├── app/
│       │   ├── layout.tsx                 # 全域佈局（Dark mode, Geist 字體）
│       │   ├── globals.css                # Tailwind + 主題變數
│       │   ├── page.tsx                   # Dashboard
│       │   ├── models/page.tsx            # 模型管理
│       │   ├── inference/page.tsx         # 推理測試
│       │   ├── benchmarks/page.tsx        # 效能測試
│       │   ├── providers/page.tsx         # Provider 管理
│       │   ├── routes/page.tsx            # 路由規則
│       │   ├── mapping/page.tsx           # 模型對映
│       │   ├── mesh/page.tsx              # Mesh 管理
│       │   ├── reports/page.tsx           # Bug Reports
│       │   ├── dev/page.tsx               # 開發除錯
│       │   └── settings/page.tsx          # 系統設定
│       ├── components/
│       │   ├── sidebar.tsx                # 側邊欄導航
│       │   └── ui/                        # Shadcn/UI 元件
│       └── lib/
│           ├── api.ts                     # API Client + TypeScript 型別（927 行）
│           ├── model-preset-recipes.ts    # 預設參數模板
│           └── utils.ts                   # 工具函式
├── docs/
│   ├── FULL_GUIDE.md                      # ← 你正在看的這份文件
│   ├── DESIGN_DOC.md                      # 原始設計文件
│   ├── SETUP.md                           # 安裝手冊
│   └── auto-catch-up.md                   # 變更日誌
├── .env.example                           # 環境變數範例
├── pyproject.toml                         # Python 依賴定義
├── uv.lock                                # Python 依賴鎖定
└── README.md                              # 專案 README
```

---

## 技術棧一覽

| 層級 | 技術 | 版本 | 用途 |
|-----|------|------|------|
| **後端框架** | FastAPI | ≥ 0.115 | 非同步 REST API、自動文檔 |
| **ORM** | SQLAlchemy | ≥ 2.0 | 資料庫存取 |
| **驗證** | Pydantic | ≥ 2.0 | 請求/回應模型驗證 |
| **HTTP Client** | httpx | ≥ 0.28 | 非同步 HTTP 請求（轉發到 Provider） |
| **資料庫** | SQLite | — | 輕量嵌入式資料庫（WAL 模式） |
| **前端框架** | Next.js | 16 | React SSR 框架 |
| **UI 函式庫** | React | 19 | 元件式 UI |
| **CSS 框架** | Tailwind CSS | 4 | Utility-first CSS |
| **UI 元件庫** | Shadcn/UI | 4 | 預建 UI 元件 |
| **Python 套件管理** | uv | — | 超快的現代 Python 套件管理器 |
| **推理引擎** | llama.cpp | — | GGUF 模型推理（llama-server, llama-bench） |
| **目標硬體** | AMD Radeon 890M | gfx1150 | Strix Point, 64GB 統一記憶體 |

---

> **最後**：如果你是第一次使用，建議從 **安裝 → 啟動 → Dashboard → Settings（設掃描目錄）→ Models（掃描 + 啟動模型）→ Inference（測試對話）** 的順序開始。遇到問題查看 Dev 頁面的即時 Log，通常能找到原因。
