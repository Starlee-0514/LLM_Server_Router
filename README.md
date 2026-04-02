# LLM Server Router

A high-performance local LLM routing system optimized for AMD Radeon 890M hardware, featuring multi-process model management, automated benchmarking, and an OpenAI-compatible API router that intelligently handles local model execution and remote fallback.

## 🌟 Overview

The LLM Server Router is designed to be the central hub for your local language models, specifically optimized for AMD hardware (like the Strix Point 890M with unified memory). It provides:

- **Local Model Management**: Easily discover and manage `.gguf` models across multiple directories.
- **Smart Routing & Fallback**: Exposes an OpenAI-compatible API. If a request can't be handled by the local model, it intelligently falls back to external APIs (OpenAI/Anthropic).
- **Multi-Runtime Support**: Run models seamlessly across different `llama.cpp` backends (ROCm, Vulkan) with custom parameters.
- **Automated Benchmarking**: Built-in support for `llama-bench` to test, compare, and store performance metrics for your hardware/model combinations.
- **Remote Access Ready**: Serve local models to other devices on your network or seamlessly integrate with IDEs (Cursor, Continue.dev) and ChatGPT-compatible clients.

## 🏗️ Architecture Architecture

The system consists of:
1. **FastAPI Backend**: Handles process control for `llama-server` and `llama-bench`, manages the SQLite database, and acts as the OpenAI-compatible router.
2. **SQLite Database**: Stores system configurations, defined model groups, and historical benchmark results.
3. **Next.js Frontend (Upcoming)**: A comprehensive UI for a dashboard overview, model management, benchmark viewer, and settings panel.

## 🚀 Quick Start

### Prerequisites
- Linux OS (Ubuntu 22.04+ recommended)
- Python 3.10+
- `uv` Python package manager
- Compiled `llama-server` binary (ROCm/Vulkan versions)

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url> LLM_Server_Router
   cd LLM_Server_Router
   ```

2. Set up environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your specific paths and API keys
   ```

3. Install dependencies:
   ```bash
   uv sync
   ```

4. Start the backend service:
   ```bash
   uv run uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
   ```
   *The Swagger API documentation will be available at `http://localhost:8000/docs`.*

## 📖 Documentation

For detailed information, please refer to the documentation:

- [Setup Guide](docs/SETUP.md): Detailed installation, configuration, and API usage.
- [Design Document](docs/DESIGN_DOC.md): Architecture overview, core features, and technical stack details.

## 🛠️ Tech Stack

- **Backend**: Python 3.10+, FastAPI, SQLAlchemy, Pydantic
- **Database**: SQLite
- **Dependency Management**: `uv`
- **Core Engine**: `llama.cpp` (`llama-server`, `llama-bench`)
