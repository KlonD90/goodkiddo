# Execution Plans

RALPHEX-aligned execution plans live here. This directory is the execution layer paired with the higher-level feature docs in `docs/plan/`.

- `docs/plan/` stays the home for high-level feature documents: what we are building and why.
- `docs/plans/` holds execution-ready plans: ordered implementation tasks, validation commands, and agent-sized steps.
- External RALPHEX loops should execute one `### Task N:` or `### Iteration N:` section per pass, validate it, mark it complete, and stop before the next section.

Use matching slugs where possible:

- `docs/plan/feature-db-active-tasks-and-notes.md`
- `docs/plans/db-active-tasks-and-notes.md`
- `docs/plan/feature-forced-checkpoints-and-conversation-compaction.md`
- `docs/plans/forced-checkpoints-and-conversation-compaction.md`

## Format

Execution plans in this directory should follow the structure expected by the RALPHEX plan-file format:

```markdown
# Plan: <name>

## Overview
Short summary of the implementation goal and boundaries.

## Validation Commands
- <command>
- <command>

### Task 1: <title>
- [ ] <step>
- [ ] <step>

### Task 2: <title>
- [ ] <step>
```

## Rules

- Keep the overview high-signal and implementation-oriented.
- Validation commands should be runnable in this repository as written.
- Task sections should be ordered and decision-complete.
- Checklist items should be small enough for an agent or engineer to execute directly.
- Each task section should be independently completable so an external loop can commit after finishing exactly one section.
