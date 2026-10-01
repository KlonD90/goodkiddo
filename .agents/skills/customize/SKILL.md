---
name: customize
description: Customize EJClaw behavior, channels, routing, integrations, prompts, or commands.
---

# EJClaw Customization

This skill assumes the grouped EJClaw architecture. Prefer extending existing channel adapters, runners, prompts, scheduling, and tool integrations through subsystem boundaries instead of mixing platform logic into the runtime.

Use the grouped subsystem folders as the canonical source layout. Top-level `src/` is intentionally minimal; edit the grouped paths directly.

## Workflow

1. First classify the request as one of: `behavior change`, `new command`, `tool integration`, `config/deploy`, or `prompt update`.
2. Narrow the impact area.
3. Edit only the relevant files.
4. Verify immediately when possible.

## Common Edit Locations

- `src/channels/discord.ts` and `src/channels/telegram.ts` - platform-specific message parsing and outbound delivery
- `src/app/index.ts` - orchestration, startup wiring, status updates
- `src/runtime/session-commands.ts` - session commands like `/compact` and `/clear`
- `src/runtime/message-runtime.ts` - message loop and turn decisions
- `src/persistence/db.ts` - registered groups, sessions, schedules, migrations
- `src/config/config.ts` - service identifiers, directories, timeouts, feature flags
- `src/agents/agent-runner.ts` - agent execution and environment propagation
- `src/providers/credential-proxy.ts` and `src/providers/credential-providers.ts` - provider-aware credential routing
- `src/paired/service-routing.ts` - owner/reviewer/arbiter routing
- `src/tasks/task-scheduler.ts` - scheduled tasks
- `runners/agent-runner/src/index.ts` - allowed tools and MCP on the Codex side
- `runners/codex-runner/src/index.ts` - execution path on the Codex side
- `setup/steps/register.ts` - channel registration
- `setup/steps/wizard.ts` - interactive setup flow
- `setup/services/service-renderers.ts` and `setup/services/service-installers.ts` - generated service files and service install behavior
- `setup/state/verify-state.ts` - setup-state summaries used by verification
- `groups/global/AGENTS.md` and each group's `AGENTS.md` - prompts and operating rules

## Request-Specific Guidance

### When You Want To Change Behavior

- response rules, mention handling, attachment handling: `src/channels/discord.ts` or `src/channels/telegram.ts`
- session commands, state machine, run loop: `src/app/index.ts`, `src/runtime/session-commands.ts`, `src/runtime/message-runtime.ts`
- persona and response style: `groups/global/AGENTS.md`

### When Adding Tools Or MCP

- Add the actual tool permissions and MCP configuration to the runner.
- On the Codex side, start with `runners/agent-runner/src/index.ts`, and update environment propagation in `src/agents/agent-runner.ts` if needed.
- Document group-specific usage rules in the appropriate `AGENTS.md`.

### When Creating A New Command

- First decide whether it is a slash command or a natural-language behavior.
- For slash or scheduled commands, inspect `src/runtime/session-commands.ts` and `src/app/index.ts`.
- If prompt-only instructions are enough, update the prompt docs instead of code.

### When Changing Registration Or Deployment Flow

- installation and verification steps live under `setup/steps/*`
- service behavior is in `setup/steps/service.ts`
- group registration format is in `setup/steps/register.ts`
- if the change is about generated unit files or service probing, check `setup/services/*`

## Verification Principles

For small changes, verify at least this much:

```bash
bun run typecheck
bun test
```

If you changed runners or execution paths, also verify:

```bash
bun run build:runners
bun run setup -- --step verify
```
