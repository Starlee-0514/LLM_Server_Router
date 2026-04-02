# Changelog

本紀錄遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 格式。

## [Unreleased]

### Added
- 專案初始化：目錄結構、`uv` 專案設定
- `docs/DESIGN_DOC.md`：專案設計文件
- `docs/SETUP.md`：安裝與使用手冊（環境設定、API 使用、遠端連線、FAQ）
- Task 1: 資料結構設計 (SQLite ORM models: Setting, ModelGroup, BenchmarkRecord)
- Task 1: 進程管理器核心類別 (`LlamaProcessManager`)
- Task 2: GGUF 模型掃描服務與 API 端點
- Task 2: Settings CRUD API 端點
- 系統架構：新增 Remote Device Access 設計（同網域、SSH Tunnel、Reverse Proxy）
- UI 設計規格：Dashboard、Model Manager、Benchmark Viewer、Settings Panel 四大頁面
- Task 3: 重構進程管理器支援多模型並行、動態 Port 分配
- Task 3: 實作模型控制端點 (`POST /api/process/start`, `stop`, `status`)
- Task 4: 實作 async `llama-bench` 執行器與 regex 數據解析，將結果寫回 SQLite
- Task 5: 實作 OpenAI 兼容 API (`/v1/chat/completions`, `/v1/models`)，處理 httpx 反向代理與未啟動模型的 503 HTTP 反應

### Changed
- 修正統一記憶體規格為 64GB
