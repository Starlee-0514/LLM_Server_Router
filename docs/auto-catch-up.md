# Auto Catch-Up Log

## 2026-04-06

- Created `docs/FULL_GUIDE.md` — a comprehensive, beginner-friendly documentation covering full system architecture (backend + frontend), installation guide, all 11 frontend page walkthroughs, complete API reference, advanced features (Mesh routing, Virtual Models, Tool Calling, Route Policies), external tool integration (Cursor, Continue.dev, Open WebUI), FAQ, and project structure reference.
- Converted ASCII architecture diagram to Mermaid for native GitHub rendering.
- Created `docs/FULL_GUIDE_EN.md` — English version of the complete guide with language switcher.
- Overhauled `README.md` — replaced ASCII art with Mermaid diagram, added Mesh/Virtual Model/Tool Calling features, updated project structure, linked both EN/CH full guides.

## 2026-04-05

- Updated overall repository structure and agent configuration documents.
- Refactored and enhanced backend logic for model providers, adding robust error handling and provider configuration extensions (Gemini CLI / GitHub device token setups).
- Improved background process manager and OpenAI compatible routers.
- Introduced a new `/api/dev` and `dev_logs.py` to support real-time system logging for debugging and transparency.
- Updated multiple frontend pages (`/dev`, `/models`, `/inference`, etc.) to provide a better UI for managing models, monitoring logs, and configuring routes.
- Adjusted sidebar and global CSS.
