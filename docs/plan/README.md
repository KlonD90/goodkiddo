# Plans

High-level feature planning documents live here.

This repository now uses two related planning layers:

| Location | Purpose |
|------|---------|
| `docs/plan/` | High-level feature docs: what and why |
| `docs/plans/` | RALPHEX-aligned execution plans: ordered implementation tasks and validation commands |

Legacy task lists in this directory still exist and remain valid. New execution-ready plans should prefer `docs/plans/`.

---

## Active plans

| Feature | Execution |
|---------|-----------|
| [Large Attachment Handling](feature-large-attachment-handling.md) | [RALPHEX plan](../plans/large-attachment-handling.md) |

## Completed

| Feature | Execution |
|---------|-----------|
| [Interchangeable Databases](feature-interchangeable-databases.md) | Legacy task lists in `docs/plan/` |
| [DB-Backed Active Tasks and Notes](feature-db-active-tasks-and-notes.md) | [RALPHEX plan](../plans/db-active-tasks-and-notes.md) |
| [Forced Checkpoints and Conversation Compaction](feature-forced-checkpoints-and-conversation-compaction.md) | [RALPHEX plan](../plans/forced-checkpoints-and-conversation-compaction.md) |
| [Voice Messages](feature-voice-messages.md) | [RALPHEX plan](../plans/telegram-voice-messages.md) |
| [PDF Documents](feature-pdf.md) | [RALPHEX plan](../plans/pdf.md) |
| [CSV and Excel Spreadsheets](feature-csv-excel.md) | [RALPHEX plan](../plans/csv-excel.md) |
| [Scheduled Timers](feature-scheduled-timers.md) | [RALPHEX plan](../plans/scheduled-timers.md) |
| [Tool Activity Status Messages](feature-tool-activity-status.md) | [RALPHEX plan](../plans/tool-activity-status.md) |

---

## Feature plan format

Describes *what* we're building and *why*. No implementation details.

```markdown
# Feature: <name>

## Summary
One paragraph. What this adds and why it matters to users.

## User cases
- <actor> can <action> so that <outcome>
- ...

## Scope
**In:** what is included.
**Out:** what is explicitly not in this iteration.

## Design notes
Key constraints, external dependencies, open questions.
```

---

## Legacy task plan format

Breaks a feature into work items an agent can complete in **10–20 minutes each**.
Each task must have one clear goal, target specific files, and a testable done condition.

```markdown
# Tasks: <feature name>

> Feature plan: [feature-<slug>.md](feature-<slug>.md)

## Task list

- [ ] **<Task title>** — one-line goal
  - **Files:** `src/path/to/file.ts`
  - **Context:** what the agent needs to know to start
  - **Done when:** specific, observable outcome (test passes / function exists / etc.)
```

### Rules for writing tasks

- One task = one logical change. If it touches more than two files, split it.
- Tasks are ordered: each one can assume the previous is complete.
- Mark done with `[x]` as work completes.
- Never put design decisions inside task items — those belong in the feature plan.

---

## Execution plans

For new execution-ready plans, use `docs/plans/` and follow the RALPHEX-aligned format documented in [../plans/README.md](../plans/README.md).
