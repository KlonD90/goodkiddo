# src

Source root for the harness.

- `bin/` — entrypoints (CLI, Telegram, admin script)
- `capabilities/` — channel-agnostic helpers such as `voice/` transcription plumbing
- `channels/` — channel adapters and dispatch (CLI, Telegram)
- `checkpoints/` — SQL-backed LangGraph history, forced checkpoint storage, and compaction triggers
- `app.ts` — caller-aware agent factory (per-user FS + permissions guard)
- `config.ts` — env + wizard config resolver
- `permissions/` — multi-tenant permissions (DB-backed, allow/ask/deny)
- `server/` — HTTP routes and browser virtual filesystem explorer; text previews are transported as base64 bytes and decoded as UTF-8 in the `web/` workspace frontend served from `web/dist`
- `tools/` — LangChain tools (FS + sandbox execution)
- `memory/` — per-caller memory wiki (notes, skills, log)
- `tasks/` — SQL-backed active task storage, prompt snapshots, and boundary reconciliation helpers
- `db/` — `Bun.SQL` factory (`createDb`) and dialect detector (`detectDialect`)
- `backends/` — virtual filesystem backend (SQLite or PostgreSQL via injected `Bun.SQL`)
- `execution/` — sandbox-side manifest validation + orchestration
- `sandbox/` — sandbox backend implementations (Docker/Firecracker)
- `model/` — LLM provider chooser
- `guest/` — runner that executes inside the sandbox
- `identities/` — system prompts
- `utils/` — small shared helpers
