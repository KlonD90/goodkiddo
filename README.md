# GoodKiddo

Security-aware AI agent harness built with TypeScript and Bun.

- Agent with file tools, sandboxed execution, and per-user state
- Per-caller memory wiki (notes, skills, log) plus SQL-backed active tasks, with `/new_thread` rotation and boundary-based task reconciliation
- Persistent conversation state in `DATABASE_URL`: full LangGraph history for audit/recovery, plus forced checkpoints that compact runtime context at `/new_thread`, session-resume, and prompt-budget boundaries and stay in the rebuilt system prompt until replaced
- Docker sandbox today, Firecracker path where supported
- CLI and Telegram entrypoints, including Telegram photo, voice, PDF document handling, spreadsheets, scheduled timers, and one-time reminders

## Run

Requirements: `bun`, `docker`, model API access.

This repository uses Bun workspaces: `bot/` for the runtime, `web/` for the
embedded authenticated bot browser UI, and `landing/` for the public marketing
site. Run workspace commands from the repository root.

Database config uses `DATABASE_URL` only, for example `sqlite://./state.db`.
Database migrations use dbmate through Bun workspace scripts. From the
repository root, run `bun run db:migrate`, `bun run db:status`,
`bun run db:rollback`, or `bun run db:new -- <migration_name>`. The wrapper
selects `bot/db/migrations/sqlite/` or `bot/db/migrations/postgres/` from
`DATABASE_URL` and normalizes Bun-style relative SQLite URLs for dbmate.
Production-like bot startup runs `db:migrate` before opening the application
database and constructing stores. Store constructors may keep defensive
`CREATE TABLE IF NOT EXISTS` setup for local development/bootstrap, but schema
changes belong in versioned migrations instead of store-local migration
helpers.
`AI_API_KEY` may be empty when you point the app at a local/custom model
endpoint with `AI_BASE_URL`. `AI_TYPE=openrouter` still requires a key.
Agent sampling uses `AI_TEMPERATURE=1.0` for the main agent and
`AI_SUB_AGENT_TEMPERATURE=0.4` for delegated sub-agents by default. The lower
sub-agent default keeps research and web-search synthesis more factual while
still leaving room for query exploration.
Telegram voice messages are enabled by default. Use `ENABLE_VOICE_MESSAGES=false`
to disable them, `TRANSCRIPTION_PROVIDER=openai|openrouter` to choose the
OpenAI-compatible transcription backend, `TRANSCRIPTION_API_KEY` to provide a
dedicated transcription credential when voice cannot reuse `AI_API_KEY`, and
`TRANSCRIPTION_BASE_URL` to override the transcription endpoint. If
`TRANSCRIPTION_PROVIDER` is unset, the app defaults to `openrouter` when
`AI_TYPE=openrouter`, otherwise `openai`. The `openai` provider uses the
Audio Transcriptions API, while `openrouter` provider uses OpenRouter's
documented chat-completions audio input flow with the default
`openai/gpt-4o-mini-transcribe` model. PDF document handling is enabled by
default. Use `ENABLE_PDF_DOCUMENTS=false` to disable it. Spreadsheet
handling is enabled by default. Use `ENABLE_SPREADSHEETS=false` to disable it.
Telegram image understanding through MiniMax MCP is opt-in. Set
`ENABLE_IMAGE_UNDERSTANDING=true` and `MINIMAX_API_KEY`; optionally override
`MINIMAX_API_HOST` for the account region. The MCP server is launched with
`uvx minimax-coding-plan-mcp -y`, so `uvx` must be installed and available on
`PATH`.
Large attachment handling uses `MAX_CONTEXT_WINDOW_TOKENS=150000`,
`CONTEXT_RESERVE_SUMMARY_TOKENS=2000`,
`CONTEXT_RESERVE_RECENT_TURN_TOKENS=2000`, and
`CONTEXT_RESERVE_NEXT_TURN_TOKENS=2000` by default; override them to tune how
much context is reserved for summaries, recent turns, and the next turn.
Telegram also emits an ephemeral attachment-compaction notice by default;
set `ENABLE_ATTACHMENT_COMPACTION_NOTICE=false` to disable only that notice,
not the underlying compaction behavior.
Telegram wall-clock and recurring timer requests require an explicit IANA
timezone from the request or from `/memory/USER.md`. Duration-only one-time
reminders like "in 30 minutes" use the Telegram message timestamp to compute a
UTC `runAtUtc` without asking for timezone. If a wall-clock or recurring timer
needs a timezone and it is not known, the agent asks for it and saves it to
`USER.md`. `USER.md` remains the canonical durable user profile; successful
profile writes mark the agent prompt for rebuild so the next turn sees the
updated timezone, and compaction refreshes the rebuilt prompt with active
checkpoint context. The web UI binds to `WEB_HOST=127.0.0.1` by default; set
`WEB_HOST` explicitly if you need it reachable on another interface.

```bash
./dev.sh
```

If config is missing, the app starts an interactive setup wizard.

New Telegram chats are automatically provisioned as free-tier users on first message. Admins can upgrade users to paid with:

```bash
bun run admin add-user telegram <chat-id> "Display name"
```

Suspended Telegram users receive the configured blocked-user message.

## Production

Ubuntu production provisioning with PostgreSQL and a systemd bot service lives
in [`ops/ansible/`](./ops/ansible/).

That playbook installs Bun, provisions a local PostgreSQL database
and role, builds the landing and embedded bot web UI as static files, configures nginx as the public
entrypoint, issues Let's Encrypt certificates for the main and `app.`
hostnames, installs the local browser/search stack (`google-chrome-stable`,
`agent-browser`, SearXNG), and runs the bot as a systemd service bound to
localhost HTTP. It is now structured around separate inventory, non-secret
vars, and Vault-backed secret vars so you do not need to edit production values
inside the playbook. It intentionally leaves Firecracker and execution sandbox
setup out for now; the example production vars keep `ENABLE_EXECUTE=false`.

Start with [`ops/README.md`](./ops/README.md).

For release checks, run:

```bash
bun run check
bun run lint
bun run test
bun run typecheck
bun run web:build
bun run landing:build
```

## Plans

- [`docs/features/`](./docs/features/) — high-level feature descriptions
- [`docs/plans/`](./docs/plans/) — execution-ready RALPHEX-aligned implementation plans, consumed one task section at a time

## Read Next

- [`ops/README.md`](./ops/README.md) for Ubuntu production provisioning with Ansible
- [`bot/src/README.md`](./bot/src/README.md) for the code map
- [`web/`](./web/) for the embedded authenticated bot browser UI workspace
- [`bot/src/channels/README.md`](./bot/src/channels/README.md) for the CLI and Telegram channels, including Telegram formatting and troubleshooting
- [`bot/src/bin/README.md`](./bot/src/bin/README.md) for entrypoints
- [`bot/src/permissions/README.md`](./bot/src/permissions/README.md) for the permission model
- [`bot/src/memory/README.md`](./bot/src/memory/README.md) for the memory subsystem
