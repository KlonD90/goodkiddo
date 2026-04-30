# Plan: Prepared Follow-ups — Nudgeable Tasks v1

## Goal
Extend GoodKiddo's existing active task model so tasks can support prepared follow-ups: due/check timing, priority, loop type, source context, and nudge/fatigue metadata.

## Product context
GoodKiddo should not send dumb reminders. It should keep business loops alive by remembering the loop, checking available context, and preparing a next step. This issue only adds the task metadata foundation; it should not implement the whole proactive engine.

## Existing areas to inspect
- `bot/src/tasks/store.ts`
- `bot/src/tasks/reconcile.ts`
- `bot/src/tasks/store.test.ts`
- `bot/src/tasks/reconcile.test.ts`
- `bot/src/tools/task_tools.ts`
- `bot/src/tools/task_tools.test.ts`
- `bot/src/db/`
- docs for DB-backed active tasks/notes in `docs/features/`

## Scope
In:
- Add durable metadata needed for future prepared follow-ups.
- Preserve compatibility with existing tasks.
- Update tests and docs.

Out:
- No scheduled digest yet.
- No browser watchers yet.
- No evidence collector yet.
- No external sending/publishing/submitting.

## Proposed metadata
Use the repo's existing DB/migration style and adjust names if needed:
- `due_at` or equivalent due timestamp.
- `next_check_at` or equivalent next proactive check timestamp.
- `priority` with a small safe enum or bounded number.
- `loop_type`: `deadline`, `client_followup`, `decision`, `watch`, `continuation`, `general`.
- `source_context` / `source_ref` for checkpoint/log/file/message reference.
- `last_nudged_at`.
- `nudge_count`.
- `snoozed_until`.
- Optional `status` compatibility if existing active/completed/dismissed model needs extension.

Prefer additive schema changes that keep old data valid.

## Validation Commands
- `bun test bot/src/tasks/store.test.ts bot/src/tasks/reconcile.test.ts bot/src/tools/task_tools.test.ts`
- `bun run typecheck`
- `bun run check`

### Task 1: Inspect current task schema and compatibility rules
- [x] Identify current task table/schema and migration pattern.
- [x] Identify existing task APIs/tools and tests.
- [x] Decide additive field names that fit current code style.

Notes:
- `bot/src/tasks/store.ts` owns the `tasks` table. It creates SQLite/Postgres DDL inline with `CREATE TABLE IF NOT EXISTS`, then creates `idx_tasks_user_status_updated_at` and `idx_tasks_user_list_status`, with SQLite WAL enabled. There is no separate migration runner for tasks today, so compatibility should be handled by additive startup schema updates that leave old rows valid.
- Current columns are `id`, `user_id`, `thread_id_created`, `thread_id_completed`, `list_name`, `title`, `note`, `status`, `status_reason`, `created_at`, `updated_at`, `completed_at`, and `dismissed_at`. Existing statuses are `active`, `completed`, and `dismissed`; this should remain unchanged for v1 compatibility.
- Existing task APIs are `addTask`, `getTask`, `listTasksForUser`, `listActiveTasks`, `countTasksForUser`, `listRecentlyCompletedTasks`, `composeActiveTaskSnapshot`, `completeTask`, and `dismissTask`. Tools expose only `task_add`, `task_complete`, `task_dismiss`, and `task_list_active`, with tests in `bot/src/tasks/store.test.ts`, `bot/src/tasks/reconcile.test.ts`, and `bot/src/tools/task_tools.test.ts`.
- Use additive snake_case DB fields with camelCase TypeScript properties: `due_at`/`dueAt`, `next_check_at`/`nextCheckAt`, `priority`, `loop_type`/`loopType`, `source_context`/`sourceContext`, `source_ref`/`sourceRef`, `last_nudged_at`/`lastNudgedAt`, `nudge_count`/`nudgeCount`, and `snoozed_until`/`snoozedUntil`. Keep defaults nullable except `priority` and `nudge_count`, which should default to bounded low-complexity values.

### Task 2: Add nudgeable task metadata
- [x] Add schema/migration support for the metadata.
- [x] Update TypeScript types/interfaces.
- [x] Ensure existing task creation/listing still works without specifying new metadata.
- [x] Ensure serialization/deserialization handles null/default values.

### Task 3: Update task tools/API surface
- [x] Allow task creation/update code paths to persist relevant metadata where appropriate.
- [x] Do not expose confusing user-facing complexity unnecessarily.
- [x] Keep direct task use simple for Telegram users.

### Task 4: Tests
- [ ] Add tests for creating old/simple tasks with defaults.
- [ ] Add tests for creating/updating tasks with due/check/priority/loop metadata.
- [ ] Add tests for migration/backward compatibility if the repo has migration tests.
- [ ] Add tests for reconcile behavior if metadata should survive reconciliation.

### Task 5: Docs
- [ ] Update the relevant feature doc or README for task metadata behavior.
- [ ] Explain that this is foundation for prepared follow-ups, not a full nudge engine.

## Acceptance Criteria
- Existing task behavior remains compatible.
- New metadata is persisted and typed.
- Tests cover defaults, persistence, and update/reconcile behavior.
- No proactive messages are sent by this issue.
