# Agent Context: LLM Server Router

## Project Overview
LLM Server Router is a high-performance local LLM routing system optimized for AMD Radeon 890M (Strix Point) hardware. It features multi-process model management, automated benchmarking, and an OpenAI-compatible API router with intelligent local/remote fallback.

## Architecture
- **Backend:** Python, FastAPI, SQLite (with WAL). Runs processes like `llama-server` and `llama-bench`.
- **Frontend:** Next.js. Provides UI for Dashboard, Models, Benchmarks, and Settings.
- **Core Engine:** Integrates heavily with `llama.cpp` (ROCm, Vulkan) for AMD hardware execution.

## Directory Structure
- `/backend/` - Contains the FastAPI application, database models, and service managers.
- `/frontend/` - Contains the Next.js React application.
- `/docs/` - Project documentation.
- `llm_router.db` - SQLite database storing models, settings, and benchmark results.

## Key Technologies
- **Python (uv-managed):** FastAPI, SQLAlchemy, SQLite, Pydantic, httpx, asyncio.
- **Node.js:** Next.js, React, Tailwind CSS.

## Agent Guidelines
1. **Tool Usage:** Prefer specific file operations (`read`, `write`, `edit`) over bash commands (`cat`, `echo`) when examining or modifying code.
2. **Context First:** Always inspect the `.env` configuration (if applicable) and cross-reference frontend and backend routes when making changes to API schemas.
3. **Database Changes:** The backend uses SQLite. Any schema changes should involve proper migration practices or updating the SQLAlchemy models depending on the project setup.
4. **Hardware Specifics:** Keep in mind that backend logic includes environment variable injections specific to AMD GPUs (e.g., `HSA_OVERRIDE_GFX_VERSION`).
5. **No Blind Overwrites:** Use the `edit` tool with targeted replacements to avoid unintentionally clobbering other parts of a file.

## Common Commands
- **Backend Setup:** `uv sync` / `uv run ...`
- **Frontend Setup:** `npm install` / `npm run dev` (run from `/frontend/`)

*This file acts as a primer for any AI coding agents operating within this workspace.*



---

# Inbox:
> must change this part and apply into current file