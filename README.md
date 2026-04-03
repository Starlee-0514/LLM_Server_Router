# LLM Server Router

A high-performance local LLM routing system optimized for AMD Radeon 890M (Strix Point) hardware, featuring multi-process model management, automated benchmarking, and an OpenAI-compatible API router with intelligent local/remote fallback.

## 🌟 Overview

The LLM Server Router is the central hub for your local language models, specifically optimized for AMD hardware with unified memory (e.g., 72GB on Strix Point). It provides:

- **Local Model Management**: Discover, organize, and manage `.gguf` models with automatic metadata extraction (publisher, quantize, param size, architecture).
- **Smart Routing & Fallback**: OpenAI-compatible API endpoint — routes to local `llama-server` instances first, falls back to external APIs (OpenAI/Anthropic) if unavailable.
- **Multi-Runtime Support**: Seamlessly switch between `llama.cpp` backends (ROCm, Vulkan) with per-model environment variable injection (e.g., `HSA_OVERRIDE_GFX_VERSION`).
- **Automated Benchmarking**: Built-in `llama-bench` integration with customizable parameters (batch sizes, GPU layers, flash attention, KV offload, prompt/generation token counts), real-time debug log streaming, and JSON import/export.
- **Remote Access Ready**: Serve local models to other devices on your network; integrate with Cursor, Continue.dev, and other OpenAI-compatible clients.

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Next.js Frontend                     │
│  Dashboard │ Models │ Benchmarks │ Settings           │
└──────────────────────┬───────────────────────────────┘
                       │ HTTP
┌──────────────────────▼───────────────────────────────┐
│                 FastAPI Backend                        │
│  ┌─────────┐  ┌──────────┐  ┌───────────────────┐    │
│  │ Process  │  │ Benchmark│  │ OpenAI-Compatible │    │
│  │ Manager  │  │ Runner   │  │ API Router        │    │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘    │
│       │              │                 │               │
│  llama-server   llama-bench      Local ↔ Remote       │
│  (ROCm/Vulkan)                   Fallback              │
└──────────────────────┬───────────────────────────────┘
                       │
              ┌────────▼────────┐
              │  SQLite Database │
              │  Settings, Groups│
              │  Benchmark Records│
              └─────────────────┘
```

## ✨ Features

### Model Management
- **Multi-directory scanning** with recursive `.gguf` file discovery
- **Automatic metadata parsing** from filenames: publisher, quantize type (Q4_K_M, Q5_K_S, etc.), parameter size (7B, 9B, 70B), and model architecture
- **Model Group presets** with configurable parameters (NGL, batch, ubatch, context size, engine type)
- **Tab-based group organization** — group models by category (e.g., "Coding", "Chat", "Embedding")
- **Search & filter** by filename, architecture, quantize type, and parameter size
- **Two-column layout** — groups and discovered files displayed side-by-side
- **Edit & delete** model group presets inline

### Benchmarking
- **Multi-parameter sweep** — specify comma-separated batch sizes and GPU layer counts for automated grid testing
- **Customizable test parameters** — prompt tokens (pp), generation tokens (tg), flash attention, KV offload
- **Real-time debug log** with auto-scroll and clear functionality
- **Results table** with best-score highlighting and scrollable history
- **Import/Export** benchmark records as JSON for backup and cross-device comparison
- **Delete** individual benchmark records

### API Router
- **OpenAI-compatible** `/v1/chat/completions` endpoint
- **Automatic routing** to running local models by name matching
- **Graceful fallback** to OpenAI or Anthropic when no local model is available
- **Multi-model parallel** — run multiple models simultaneously on different ports

### Dashboard
- Real-time status monitoring of all running `llama-server` processes
- GPU/memory awareness for AMD Radeon 890M

## 🚀 Quick Start

### Prerequisites
- Linux OS (Ubuntu 22.04+ recommended)
- Python 3.10+
- Node.js 18+ (for frontend)
- `uv` Python package manager
- Compiled `llama.cpp` binaries (`llama-server`, `llama-bench`) — ROCm or Vulkan builds

### Installation

1. **Clone the repository:**
   ```bash
   git clone git@github.com:Starlee-0514/LLM_Server_Router.git
   cd LLM_Server_Router
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your paths and API keys:
   ```env
   LLAMA_ROCM_PATH=~/Documents/Software/pkgs/llama_rocm/llama-server
   LLAMA_VULKAN_PATH=~/Documents/Software/pkgs/llama_vulkan/llama-server
   HSA_OVERRIDE_GFX_VERSION=11.5.0
   OPENAI_API_KEY=sk-...
   ANTHROPIC_API_KEY=sk-ant-...
   ```

3. **Install backend dependencies:**
   ```bash
   uv sync
   ```

4. **Install frontend dependencies:**
   ```bash
   cd frontend && npm install && cd ..
   ```

5. **Start the backend:**
   ```bash
   uv run uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
   ```

6. **Start the frontend (in a separate terminal):**
   ```bash
   cd frontend && npm run dev
   ```

7. **Open the dashboard:** Navigate to `http://localhost:3000`

> **API Docs**: Swagger UI available at `http://localhost:8000/docs`

## 📖 Documentation

For detailed information, refer to:

- [Setup Guide](docs/SETUP.md) — Installation, configuration, and API usage
- [Design Document](docs/DESIGN_DOC.md) — Architecture overview, core features, and technical stack

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python 3.10+, FastAPI, SQLAlchemy, Pydantic |
| **Frontend** | Next.js 16, React, Tailwind CSS, Shadcn/UI |
| **Database** | SQLite |
| **Dependencies** | `uv` (Python), `npm` (Node.js) |
| **Core Engine** | `llama.cpp` (`llama-server`, `llama-bench`) |
| **Target Hardware** | AMD Radeon 890M (gfx1150), 72GB unified memory |

## 📁 Project Structure

```
LLM_Server_Router/
├── backend/
│   └── app/
│       ├── main.py              # FastAPI app entry point
│       ├── models.py            # SQLAlchemy ORM models
│       ├── schemas.py           # Pydantic request/response schemas
│       ├── database.py          # Database session management
│       ├── core/
│       │   ├── config.py        # Environment config (Settings)
│       │   └── process_manager.py  # llama-server process lifecycle
│       ├── services/
│       │   ├── model_scanner.py    # GGUF file discovery & metadata
│       │   └── benchmark_runner.py # llama-bench execution & parsing
│       └── api/routers/
│           ├── model_routes.py       # /api/models/*
│           ├── model_group_routes.py # /api/model-groups/*
│           ├── process_routes.py     # /api/process/*
│           ├── benchmark_routes.py   # /api/benchmarks/*
│           ├── settings_routes.py    # /api/settings
│           └── openai_routes.py      # /v1/chat/completions
├── frontend/
│   └── src/
│       ├── app/
│       │   ├── page.tsx         # Dashboard
│       │   ├── models/page.tsx  # Model Manager (two-column)
│       │   ├── benchmarks/page.tsx  # Benchmark Viewer
│       │   └── settings/page.tsx    # Settings
│       ├── components/
│       │   ├── sidebar.tsx      # Navigation sidebar
│       │   └── ui/              # Shadcn/UI components
│       └── lib/
│           └── api.ts           # API client & TypeScript types
├── docs/
│   ├── DESIGN_DOC.md
│   └── SETUP.md
├── .env.example
├── pyproject.toml
└── README.md
```

## 📝 License

This project is for personal and educational use.
