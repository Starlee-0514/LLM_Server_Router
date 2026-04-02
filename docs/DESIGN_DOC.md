# LLM Server Router - 設計文件

> **專案目標**：建立一個本地 LLM 路由管理系統，為 AMD Radeon 890M (Strix Point, 64GB 統一記憶體) 最佳化，提供模型管理、Runtime 切換、效能基準測試與 OpenAI 相容的 API 路由。支援從遠端裝置透過同一路由端點存取本地模型服務。

## 1. 系統架構

```
                     ┌───────────────────────┐
                     │   Remote Devices      │
                     │  (Laptop / Phone /    │
                     │   Other Servers)      │
                     └───────────┬───────────┘
                                 │ HTTP/REST (OpenAI-compat)
                                 │
┌────────────────────────────────▼────────────────────────────┐
│                        Frontend                             │
│               (Next.js + Tailwind + Shadcn/UI)              │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐  │
│  │Dashboard │ │ Model    │ │ Benchmark │ │  Settings    │  │
│  │ Overview │ │ Manager  │ │ Viewer    │ │  Panel       │  │
│  └──────────┘ └──────────┘ └───────────┘ └──────────────┘  │
└────────────────────────────┬───────────────────────────────┘
                             │ HTTP/REST
┌────────────────────────────▼───────────────────────────────┐
│                     FastAPI Backend                         │
│  ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ API Router│ │ Settings │ │ Process  │ │ Benchmark   │  │
│  │ (OpenAI   │ │ Manager  │ │ Manager  │ │ Runner      │  │
│  │  compat)  │ │          │ │ (llama-  │ │ (llama-     │  │
│  │          │ │          │ │  server)  │ │  bench)     │  │
│  └─────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬──────┘  │
│        │            │            │              │          │
│  ┌─────▼────────────▼────────────▼──────────────▼───────┐  │
│  │                  SQLite Database                      │  │
│  │  (settings, model_groups, benchmarks)                 │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
         │                          │
    ┌────▼─────┐            ┌──────▼──────┐
    │ Local    │            │  Remote API  │
    │ llama-   │            │ (Anthropic/  │
    │ server   │            │  OpenAI)     │
    └──────────┘            └─────────────┘
```

### 1.1 遠端裝置存取（Remote Device Access）

本系統對外暴露一組 **OpenAI-compatible API** 端點（`/v1/chat/completions`, `/v1/models` 等），因此任何支援 OpenAI API 格式的客戶端都能直接連線使用，包括：

- **同網域的其他電腦**：透過區域網路 IP (`http://192.168.x.x:8000`)
- **手機 / 平板**：使用支援 OpenAI API 的 App（如 ChatGPT-compatible clients）
- **遠端伺服器**：透過 SSH tunnel 或 reverse proxy（Caddy/Nginx）對外暴露
- **開發工具整合**：VS Code / Cursor / Continue.dev 等 IDE 外掛直接指向本路由

路由邏輯統一處理：
1. 請求進入 → 檢查本地 llama-server 是否有可用模型
2. **本地可用** → 直接轉發至本地 llama-server
3. **本地不可用** → fallback 到遠端 API (Anthropic / OpenAI)

---

## 2. Core Features

### 2.1 Runtime Management
- 支援切換不同的 `llama.cpp` 二進位檔路徑（Vulkan 版、ROCm 版）
- 執行時可注入環境變數（如 `HSA_OVERRIDE_GFX_VERSION=11.5.0`）
- 路徑設定透過 `.env` 檔案管理

### 2.2 Model Management
- 掃描多個本地資料夾中的 `.gguf` 檔案
- 掃描目錄可透過 UI 設定端點配置，持久化至 SQLite
- 「模型群組」功能：預設 llama-server 啟動參數 (n_ngl, batch, ubatch, ctx_size)

### 2.3 Benchmarking
- 整合 `llama-bench`
- 解析 stdout 中的 t/s 數據並存入 SQLite
- 支援不同參數之間的效能對比

### 2.4 API Router
- OpenAI API 相容伺服器
- 路由邏輯：優先本地模型 → fallback 遠端 API (Anthropic/OpenAI)
- 統一端點：本地與遠端裝置皆透過相同的 API 格式存取

### 2.5 Remote Device Access
- 對外暴露 OpenAI-compatible API，支援同網域或遠端裝置連線
- 支援透過 reverse proxy 或 SSH tunnel 對外服務
- 所有連線共享相同的路由邏輯與 fallback 機制

---

## 3. UI 設計

Frontend 採用 Next.js + TailwindCSS + Shadcn/UI，提供以下頁面：

### 3.1 Dashboard (儀表板)
首頁總覽，顯示系統即時狀態：
- **llama-server 狀態**：運行中/停止、PID、引擎類型、已載入的模型、uptime
- **系統資源監控**：GPU 使用率、記憶體佔用
- **最近的 Benchmark 結果**：最後幾次測試的 t/s 摘要
- **API 請求統計**：今日請求數、本地 vs 遠端的比例

### 3.2 Model Manager (模型管理)
管理本地 GGUF 模型：
- **模型清單**：從已設定的目錄掃描出的所有 `.gguf` 檔案，顯示名稱、大小、路徑
- **一鍵啟動**：選取模型後直接啟動 llama-server（可選引擎、調整參數）
- **模型群組**：建立/編輯預設的啟動參數組合，一鍵套用

### 3.3 Benchmark Viewer (效能對比)
瀏覽與對比 llama-bench 測試結果：
- **測試紀錄表格**：依模型名稱、引擎、參數排序與篩選
- **對比圖表**：視覺化 pp t/s 與 tg t/s 在不同參數設定下的差異
- **執行測試**：選取模型與參數範圍，一鍵執行 llama-bench

### 3.4 Settings Panel (設定面板)
系統配置管理：
- **掃描目錄管理**：新增/移除 GGUF 模型掃描目錄
- **Runtime 設定**：切換 ROCm / Vulkan 引擎、設定環境變數
- **遠端 API 金鑰**：設定 OpenAI / Anthropic API Key
- **網路存取**：設定監聽位址與 CORS、API Token 認證

---

## 4. 技術選型

| 層級 | 技術 | 理由 |
|---|---|---|
| Backend | FastAPI (Python 3.10+) | 非同步支援、自動文檔、型別安全 |
| Frontend | Next.js + TailwindCSS + Shadcn/UI | 現代 React 框架、一致的 UI 元件庫 |
| DB | SQLite + SQLAlchemy | 輕量、無需額外服務、ORM 支援 |
| 依賴管理 | uv | 極快的現代 Python 套件管理器 |
| 進程管理 | Python subprocess | 直接控制 llama-server 生命週期 |

## 5. 硬體環境

- **GPU**: AMD Radeon 890M (Strix Point)
- **記憶體**: 64GB 統一記憶體
- **Runtime**: ROCm (主要) / Vulkan (備用)
- **關鍵環境變數**: `HSA_OVERRIDE_GFX_VERSION=11.5.0`

## 6. 開發階段

| 階段 | 內容 | 狀態 |
|---|---|---|
| Task 1 | 資料結構設計 + 進程管理器核心類別 | ✅ 完成 |
| Task 2 | GGUF 模型掃描 API | ✅ 完成 |
| Task 3 | 多模型並行進程管理 + ModelGroup CRUD + 一鍵啟動 API | ✅ 完成 |
| Task 4 | llama-bench 整合 (async 執行、regex 解析、SQLite 儲存) | ✅ 完成 |
| Task 5 | OpenAI 相容 API Router + Fallback + 503 機制 | ✅ 完成 |
| Task 6 | Frontend UI (Dashboard, Model Manager, Benchmark, Settings) | ✅ 完成 |
