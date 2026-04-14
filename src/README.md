# src

Source root for the harness.

- `bin/` — entrypoints (CLI, Telegram, admin script)
- `app.ts` — caller-aware agent factory (per-user FS + permissions guard)
- `config.ts` — env + wizard config resolver
- `permissions/` — multi-tenant permissions (DB-backed, allow/ask/deny)
- `tools/` — LangChain tools (FS + sandbox execution)
- `backends/` — virtual filesystem backend (SQLite today)
- `execution/` — sandbox-side manifest validation + orchestration
- `sandbox/` — sandbox backend implementations (Docker/Firecracker)
- `model/` — LLM provider chooser
- `guest/` — runner that executes inside the sandbox
- `identities/` — system prompts
- `utils/` — small shared helpers
