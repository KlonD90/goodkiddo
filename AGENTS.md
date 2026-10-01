# GoodKiddo

Personal single-agent Telegram assistant. The active product handles private requests/reminders and group meeting coordination. The 2026-09-29 handoff replaces the legacy mandatory Owner/Reviewer/Arbiter workflow.

## Start here

- Bootstrap: `src/app/telegram-assistant.ts`
- Telegram transport: `src/channels/telegram-assistant-api.ts`
- Incoming messages, commands and buttons: `src/assistant/ingress.ts`
- Agent turns and tools: `src/assistant/agent.ts`, `src/assistant/tools.ts`
- Queue and interrupted turns: `src/assistant/worker.ts`
- Meetings: `src/assistant/meetings.ts`
- Timers: `src/tasks/assistant-scheduler.ts`
- Delivery retries: `src/assistant/delivery.ts`
- Persistence: `src/persistence/assistant-store.ts`, `src/persistence/assistant-schema.ts`
- Provider and search: `src/providers/assistant-llm.ts`, `src/providers/assistant-search.ts`
- Configuration: `src/config/assistant-config.ts`
- Privacy-preserving analytics: `src/integrations/assistant-analytics.ts`
- Implementation notes/limits: `docs/telegram-assistant.md`

## Product rules

- One agent. Additional reviewers/arbiter are not required by the new product.
- Context, tasks and tool authorization are scoped to the current chat.
- Future actions must be persisted before the bot promises to return.
- Meetings collect each participant's own availability. Do not fabricate participants, agreement, bookings, prices or source links.
- Provider/model selection is configuration. Keep costs and tool-call budgets bounded.
- Analytics must never contain raw Telegram IDs, usernames, names, message text or exception traces.
- No automatic service startup/deployment merely to inspect or edit code.

## Development

Use Bun: `bun install`, `bun run dev`, `bun run build`, `bun start`.
Tests/typecheck remain `bun run test` and `bun run typecheck`; honor an explicit user request to skip checks. The legacy test suite mostly covers the prior implementation.

The new private store is `store/assistant.db`. Do not overwrite or migrate `store/messages.db`, legacy sessions, or private `.env` without task scope requiring it. Generated dependencies/builds/data/logs are ignored.

The historical orchestrator is `src/app/index.ts`. Discord, paired workflows, SDK runners, container support and the old setup remain legacy. Use `dev:legacy`, `build:legacy`, `start:legacy` only when explicitly working on that stack. Historical overview: `docs/legacy-readme.md`, `src/config/config.ts`. Read `setup/README.md` before modifying legacy setup.

## Maintainability

Follow `MAINTAINABILITY.md`: focused files, explicit boundaries, named helpers, side effects at the edges, predictable subsystem placement. Keep transport in channels, orchestration in app/assistant, persistence in persistence and provider HTTP details in providers. Improve touched legacy code opportunistically without unrelated rewrites.

## Git workflow

After each completed implementation step, stage relevant files and create a concise commit. Do not amend, rebase or rewrite history without explicit user instruction. Preserve unrelated local changes. The pre-commit hook formats all source files; when checks are explicitly excluded, bypass it and limit any formatting to the files you authored.
