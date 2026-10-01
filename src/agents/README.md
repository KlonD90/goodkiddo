# Agents

This folder owns agent execution mechanics: runner setup, environment preparation, output protocol, and isolated reviewer execution.

## Main Files

- `agent-runner.ts` - spawns agent child processes and handles streamed outputs
- `agent-runner-environment.ts` - prepares runner env/session layout
- `agent-runner-snapshot.ts` - writes group/task snapshots for runners
- `agent-output.ts` - structured output helpers
- `agent-protocol.ts` - runner output markers and protocol constants
- `agent-error-detection.ts` - classifies agent/provider-triggered failures
- `session-recovery.ts` - session poisoning / fresh-session retry logic
- `container-runner.ts` - reviewer container execution
- `container-runtime.ts` - container runtime support helpers

## Start Here

1. `agent-runner.ts`
2. `agent-runner-environment.ts`
3. `container-runner.ts`

## Boundaries

- Model/provider routing stays in `../providers/`
- Runtime message decisions stay in `../runtime/`
- Paired role decisions stay in `../paired/`

## Maintainability Notes

- Keep runner code focused on lifecycle, environment preparation, and output protocol.
- Push provider policy, platform behavior, and unrelated formatting logic out of this folder.
- Follow the review triggers in [`MAINTAINABILITY.md`](../../MAINTAINABILITY.md) when a runner file starts carrying multiple concerns.
