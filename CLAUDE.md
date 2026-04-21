# CLAUDE.md

## Quick Context

- `docs/plan/` holds high-level feature documents.
- `docs/plans/` holds execution-ready RALPHEX plans with ordered task sections and runnable validation commands.
- `src/capabilities/` holds reusable capability modules; voice transcription lives in `src/capabilities/voice/`, PDF document parsing lives in `src/capabilities/pdf/`, and CSV/Excel spreadsheet parsing lives in `src/capabilities/spreadsheet/`.
- Telegram channel behavior, including voice-message, PDF-document, and spreadsheet handling and limits, is documented in `src/channels/README.md`.
- Voice transcription capability structure and provider extension points are documented in `src/capabilities/voice/README.md`.
- PDF parsing capability structure and extractor interface are documented in `src/capabilities/pdf/README.md`.
- Spreadsheet parsing capability structure and parser interface are documented in `src/capabilities/spreadsheet/README.md`.
- Scheduled timers (`src/capabilities/timers/`) let the agent run memory file prompts on cron schedules. Timer tools available to the LLM: `create_timer(mdFilePath, cronExpression, timezone?)`, `list_timers()`, `update_timer(timerId, updates)`, `delete_timer(timerId)`. See `src/capabilities/timers/README.md` for cron format and notification backend extension points.

## Memory And Tasks

- Durable facts, preferences, and reusable procedures belong in `/memory/` and `/skills/`.
- Actionable work belongs in the SQL task store under `src/tasks/`.
- Use task tools for open work. Use memory files for durable knowledge.
- `task_dismiss` is confirmation-gated: only dismiss after the user explicitly confirms in the current turn.

## Conversation State

- `full_history != runtime_context`.
- Full LangGraph history stays in SQL for audit and recovery.
- Model-facing runtime context is rebuilt from the latest forced checkpoint summary, recent turns, active tasks, and the current user input.
- Compaction boundaries are coordinated by `src/checkpoints/compaction_trigger.ts`.

## Validation

- DB-backed tasks and notes:
  - `bun test src/channels/shared.test.ts src/channels/session_commands.test.ts`
  - `bun test src/tools/task_tools.test.ts src/tasks/store.test.ts src/tasks/reconcile.test.ts`
- Forced checkpoints and compaction:
  - `bun test src/checkpoints/compaction_trigger.test.ts src/memory/checkpoint_compaction.test.ts src/memory/runtime_context.test.ts`
