# src

Source root for the harness.

- `bin/` — entrypoints (CLI, Telegram, admin script)
- `capabilities/` — channel-agnostic helpers such as `voice/` transcription plumbing
- `channels/` — channel adapters and dispatch (CLI, Telegram)
- `checkpoints/` — SQL-backed LangGraph history, forced checkpoint storage, and compaction triggers
- `app.ts` — caller-aware agent factory (per-user FS + tool status wrapping)
- `config.ts` — env + wizard config resolver
- `permissions/` — user access state (tier, status, identity)
- `server/` — HTTP routes and browser virtual filesystem explorer; the bot web server serves `web/dist` under `/fs/`, text previews are transported as base64 bytes and decoded as UTF-8 in the `web/` workspace frontend, and `stat` resolves slashless existing directory paths so markdown links like `/reports` can open `/reports/`
- `tools/` — LangChain tools (FS + sandbox execution)
- `memory/` — per-caller memory wiki (notes, skills, log)
- `tasks/` — Prisma-backed active task storage, prompt snapshots, and boundary reconciliation helpers
- `db/` — Prisma client factory and PostgreSQL URL validation
- `backends/` — virtual filesystem backend backed by the injected Prisma client
- `execution/` — sandbox-side manifest validation + orchestration
- `sandbox/` — sandbox backend implementations (Docker/Firecracker)
- `model/` — LLM provider chooser
- `guest/` — runner that executes inside the sandbox
- `identities/` — system prompts
- `utils/` — small shared helpers

PostgreSQL stores that persist millisecond timestamps from `Date.now()` use
`BIGINT` columns. Store initialization also migrates older Postgres timestamp
columns from `INTEGER` to `BIGINT` so production tables can accept current
epoch-millisecond values.
