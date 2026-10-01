# Source Layout

The grouped folders in `src/` are the canonical structure for GoodKiddo. Top-level `src/` is intentionally kept minimal; implementation code lives in the subsystem folders below.

The writing and review standard for all source changes lives in [`../MAINTAINABILITY.md`](../MAINTAINABILITY.md). Local folder READMEs describe subsystem boundaries; the maintainability guide explains how code inside those boundaries should be written.

## Folder Guide

- `app/` - service bootstrap and startup wiring
- `config/` - environment loading, configuration, logging
- `shared/` - shared types and small utilities
- `channels/` - platform adapters such as Discord
- `runtime/` - message loop, queueing, turn control, session commands
- `agents/` - agent runner, runner environment, reviewer container
- `providers/` - provider registry, credential proxy, token rotation, model routing
- `paired/` - owner/reviewer/arbiter workflow
- `tasks/` - scheduler and task lifecycle helpers
- `routing/` - outbound formatting and sender/trigger routing
- `persistence/` - database and cursor/restart state
- `shared/README.md` - cross-cutting types/utilities boundaries
- `persistence/README.md` - schema, migrations, and storage boundaries
- `groups/` - group folder helpers and prompt loading
- `dashboard/` - unified/status dashboard rendering
- `integrations/` - IPC and other external service integration points

The highest-churn subsystems also have local READMEs:

- `channels/README.md`
- `runtime/README.md`
- `agents/README.md`
- `persistence/README.md`
- `providers/README.md`
- `paired/README.md`
- `shared/README.md`

## Reading Order

1. `app/index.ts`
2. `channels/discord.ts`
3. `runtime/message-runtime.ts`
4. `runtime/message-agent-executor.ts`
5. `agents/agent-runner.ts`
6. `providers/credential-providers.ts`
7. `persistence/db.ts`
