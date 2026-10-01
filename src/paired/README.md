# Paired Workflow

This folder owns the owner/reviewer/arbiter workflow and the structures around paired tasks and paired workspaces.

## Main Files

- `service-routing.ts` - decides which service owns which role in a room
- `paired-execution-context.ts` - prepares paired-task execution context and handoff details
- `paired-workspace-manager.ts` - manages paired workspaces and snapshots
- `room-role-context.ts` - role labels and room-role metadata passed to runners
- `role-agent-plan.ts` - resolves which agent type should act for each role
- `arbiter-context.ts` - builds arbiter prompt context

## Start Here

1. `service-routing.ts`
2. `role-agent-plan.ts`
3. `paired-execution-context.ts`

## Boundaries

- Message-loop orchestration stays in `../runtime/`
- Agent process spawning stays in `../agents/`
- Persistent paired-task records stay in `../persistence/`
