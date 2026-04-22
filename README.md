# GoodKiddo

Security-aware AI agent harness built with TypeScript and Bun.

- Agent with file tools, sandboxed execution, and per-user state
- Per-caller memory wiki (notes, skills, log) plus SQL-backed active tasks, with `/new_thread` rotation and boundary-based task reconciliation
- Persistent conversation state in `DATABASE_URL`: full LangGraph history for audit/recovery, plus forced checkpoints that compact runtime context at `/new_thread`, session-resume, and prompt-budget boundaries
- Docker sandbox today, Firecracker path where supported
- CLI and Telegram entrypoints, including Telegram photo, voice, PDF document handling, spreadsheets, and scheduled timers for multimodal models

## Run

Requirements: `bun`, `docker`, model API access.

Database config uses `DATABASE_URL` only, for example `sqlite://./state.db`.
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
Large attachment handling uses `MAX_CONTEXT_WINDOW_TOKENS=150000`,
`CONTEXT_RESERVE_SUMMARY_TOKENS=2000`,
`CONTEXT_RESERVE_RECENT_TURN_TOKENS=2000`, and
`CONTEXT_RESERVE_NEXT_TURN_TOKENS=2000` by default; override them to tune how
much context is reserved for summaries, recent turns, and the next turn.
Set `TIMEZONE=America/New_York` to control the default timezone for
scheduled timers (defaults to `UTC`).

```bash
./dev.sh
```

If config is missing, the app starts an interactive setup wizard.

## Plans

- [`docs/plan/`](./docs/plan/) — high-level feature plans
- [`docs/plans/`](./docs/plans/) — execution-ready RALPHEX-aligned implementation plans, consumed one task section at a time

## Read Next

- [`src/README.md`](./src/README.md) for the code map
- [`src/channels/README.md`](./src/channels/README.md) for the CLI and Telegram channels, including Telegram formatting and troubleshooting
- [`src/bin/README.md`](./src/bin/README.md) for entrypoints
- [`src/permissions/README.md`](./src/permissions/README.md) for the permission model
- [`src/memory/README.md`](./src/memory/README.md) for the memory subsystem
