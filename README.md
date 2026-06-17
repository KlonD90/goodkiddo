# GoodKiddo

Security-aware AI agent harness built with TypeScript and Bun.

- Agent with file tools, sandboxed execution, and per-user state
- Per-caller memory wiki (notes, skills, log) plus SQL-backed active tasks, with `/new_thread` rotation and boundary-based task reconciliation
- Persistent conversation state in `DATABASE_URL`: full LangGraph history for audit/recovery, plus forced checkpoints that compact runtime context at `/new_thread`, session-resume, and prompt-budget boundaries and stay in the rebuilt system prompt until replaced
- Docker sandbox today, Firecracker path where supported
- CLI and Telegram entrypoints, including Telegram photo, voice, PDF document handling, spreadsheets, scheduled timers, and one-time reminders

## Memory & K2.6 defaults

GoodKiddo is tuned for Kimi K2.6 out of the box:

- `AI_TYPE=kimi` with `AI_MODEL_NAME=kimi-k2-6` and Moonshot's OpenAI-compatible endpoint (`https://api.moonshot.cn/v1`) are the production defaults.
- `MAX_CONTEXT_WINDOW_TOKENS=200000` leaves headroom inside K2.6's 256K context window.
- `MEMORY_PROMPT_CHAR_CAP=24000` (~6000 tokens) lets the eager-loaded memory wiki scale with the larger context; override it for smaller models.
- Compaction summarizes older conversation into a structured `CheckpointSummary` with a dedicated `critical_facts` array. Explicit "remember this" facts, active goals, hard constraints, unfinished work, pending approvals, and named artifacts/IDs are preserved and re-injected into the runtime context, so compaction does not silently forget them.

## Run

Requirements: `bun`, `docker`, model API access.

This repository uses Bun workspaces: `bot/` for the runtime, `web/` for the
embedded authenticated bot browser UI, and `landing/` for the public marketing
site. Run workspace commands from the repository root.
Optimize checked-in landing and web image assets with:

```bash
bun run images:optimize
```

The optimizer uses `sharp`, skips generated `dist/` folders, and only rewrites
an image when the optimized output is meaningfully smaller. Use
`bun run images:check` in review flows to detect images that still need
optimization.

Database config uses `DATABASE_URL` only and expects PostgreSQL. Local
development uses Prisma Dev/PGlite when `DATABASE_URL` is unset: bot startup
starts the local database, uses the generated TCP URL, lazily runs
`db:generate` if the Prisma client is missing, applies committed migrations with
`db:migrate`, and then starts normal runtime. To run
those steps manually:

```bash
bun run db:dev
export DATABASE_URL='<postgres URL printed by db:dev>'
bun run db:migrate
```

Use `bun run db:dev:stop` to stop the local PGlite server. Production should set
`DATABASE_URL` to the real PostgreSQL database and apply committed migrations
with `bun run db:migrate`. The runtime starts a Prisma client and routes user
state through a model mapped to the existing
`harness_users` table. `sqlite://...` runtime URLs are no longer supported.
`AI_API_KEY` may be empty when you point the app at a local/custom model
endpoint with `AI_BASE_URL`. `AI_TYPE=openrouter` and `AI_TYPE=kimi` still
require a key. GoodKiddo has native Kimi K2.6 support via Moonshot's
OpenAI-compatible API; set `AI_TYPE=kimi` and `AI_MODEL_NAME=kimi-k2-6`
(defaults are applied automatically).
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
Context handling is tuned for Kimi K2.6 by default:
`MAX_CONTEXT_WINDOW_TOKENS=200000`,
`CONTEXT_RESERVE_SUMMARY_TOKENS=2000`,
`CONTEXT_RESERVE_RECENT_TURN_TOKENS=2000`, and
`CONTEXT_RESERVE_NEXT_TURN_TOKENS=2000`. Override them to tune how much
context is reserved for summaries, recent turns, and the next turn on smaller
models. The memory prompt cap defaults to `MEMORY_PROMPT_CHAR_CAP=24000`
(~6000 tokens) so the eager-loaded memory wiki can scale with K2.6's 256K
context window; set it lower for smaller models.
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
checkpoint context.

Recurring timers support notification modes (`verbose`, `summary`,
`errors_only`, `silent`) via the `TIMER_NOTIFY_MODE_DEFAULT` environment
variable, which defaults to `summary` so new timers are quiet. Set
`TELEGRAM_STATUS_DEBOUNCE_MS` (default `5000`) to collapse rapid Telegram
status updates into one message. See `bot/src/capabilities/timers/README.md`
for details. The web UI binds to `WEB_HOST=127.0.0.1` by default; set
`WEB_HOST` explicitly if you need it reachable on another interface.

```bash
./dev.sh
```

Prisma is used for the PostgreSQL production path. Regenerate the client after
schema changes from the bot workspace with:

```bash
bun run --filter goodkiddo-bot db:generate
```

Apply committed Prisma migrations to a production PostgreSQL database with:

```bash
DATABASE_URL='postgresql://...' bun run --filter goodkiddo-bot db:migrate
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
and role, builds the landing and embedded bot web UI as static files, serves
the generated `landing/dist/` bundle through nginx for the main hostname,
serves the `app.` file-share UI bundle through nginx behind Cloudflare Flexible
SSL, proxies file-share API and download routes to the Bun service, installs
the local browser/search stack (`google-chrome-stable`,
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
bun run images:check
bun run web:build
bun run landing:build
```

To run just the frontend builds with explicit environment values:

```bash
POSTHOG_KEY=ci-public-placeholder POSTHOG_HOST=https://us.i.posthog.com bun run landing:build
bun run web:build
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
- [`bot/src/permissions/README.md`](./bot/src/permissions/README.md) for user access state
- [`bot/src/memory/README.md`](./bot/src/memory/README.md) for the memory subsystem
