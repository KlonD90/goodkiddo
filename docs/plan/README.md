# Plans

Planning documents live here. Two types, one per feature/initiative.

| Type | Prefix | Purpose |
|------|--------|---------|
| Feature | `feature-*.md` | High-level: what and why, user cases, scope |
| Tasks | `tasks-*.md` | Low-level: agent-sized work items, 10–20 min each |

Use matching slugs: `feature-voice-messages.md` → `tasks-voice-messages.md`.

---

## Active plans

| Feature | Task lists |
|---------|-----------|
| [Interchangeable Databases](feature-interchangeable-databases.md) | [01 Foundation](tasks-db-01-foundation.md) · [02 Migrate Stores](tasks-db-02-migrate-stores.md) · [03 Checkpoint & Wiring](tasks-db-03-checkpoint-and-wiring.md) |
| [Voice Messages](feature-voice-messages.md) | [Tasks](tasks-voice-messages.md) |

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

## Task plan format

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
