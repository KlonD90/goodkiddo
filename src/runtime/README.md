# Runtime

This folder owns the live message-processing flow after a platform adapter has produced normalized inbound messages.

## Main Files

- `message-runtime.ts` - high-level message loop decisions per chat
- `message-runtime-rules.ts` - filtering and gating rules used by the runtime
- `message-agent-executor.ts` - executes a single agent turn from runtime context
- `message-turn-controller.ts` - manages turn-level output flow
- `session-commands.ts` - `/clear`, `/compact`, and related session controls
- `group-queue.ts` - per-group concurrency and active-process tracking
- `group-queue-ipc.ts` - queue-related IPC helpers
- `bot-message-filter.ts` - bot/control-message filtering before processing

## Start Here

1. `message-runtime.ts`
2. `message-runtime-rules.ts`
3. `message-agent-executor.ts`

## Boundaries

- Platform-specific input stays in `../channels/`
- Agent runner internals stay in `../agents/`
- Owner/reviewer/arbiter policy stays in `../paired/`
- DB/state persistence stays in `../persistence/`

## Maintainability Notes

- Keep runtime files orchestration-focused.
- Move rule-heavy logic into focused helpers before the main loop becomes hard to scan.
- Follow the review triggers in [`MAINTAINABILITY.md`](../../MAINTAINABILITY.md) when files or functions start growing.
