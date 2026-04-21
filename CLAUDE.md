# CLAUDE.md

## Quick Context

- `docs/plan/` holds high-level feature documents.
- `docs/plans/` holds execution-ready RALPHEX plans with ordered task sections and runnable validation commands.
- Telegram channel behavior, including voice-message handling and limits, is documented in `src/channels/README.md`.
- Voice transcription capability structure and provider extension points are documented in `src/capabilities/voice/README.md`.

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
