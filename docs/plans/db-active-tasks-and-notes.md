# Plan: DB-Backed Active Tasks and Notes

## Overview
Add structured per-caller active tasks in SQL, keep notes in the existing memory wiki, load active tasks into prompt context, and reconcile tasks at session-start and post-`/new_thread` boundaries.

## Validation Commands
- `bun tsc --noEmit`
- `bun test src/memory/session_loader.test.ts src/memory/rotate_thread.test.ts`
- `bun test src/channels/session_commands.test.ts`
- `bun test src/tools/memory_tools.test.ts`
- `bun test src/tasks/store.test.ts src/tasks/reconcile.test.ts`

### Task 1: Add SQL task store
- [x] Create `src/tasks/store.ts` with table init, query helpers, and status transitions.
- [x] Add tests for add, list, complete, and dismiss flows scoped by caller.
- [x] Store `thread_id_created`, `thread_id_completed`, `list_name`, `title`, `note`, `status`, and timestamp fields on each task row.
- [x] Add indexes for `(user_id, status, updated_at DESC)` and `(user_id, list_name, status)`.

### Task 2: Add agent-facing task tools and prompt guidance
- [x] Add `task_add({ listName, title, note? })`.
- [x] Add `task_complete({ taskId })`.
- [x] Add `task_dismiss({ taskId, reason? })`.
- [x] Add `task_list_active({ limit? })`.
- [x] Register the new task tools in the execution tool factory.
- [x] Update prompt guidance so durable facts still use `memory_write`, while actionable work uses the task tools.
- [x] Extend prompt building to inject a compact active-task snapshot from SQL on every agent build.

### Task 3: Add boundary-based task reconciliation
- [x] Extend channel session state with a `pendingTaskCheck` flag.
- [x] Set `pendingTaskCheck = true` on initial channel-session creation.
- [x] Set `pendingTaskCheck = true` after `/new_thread`.
- [x] Implement a preflight reconciliation step over active tasks plus the current user message.
- [x] Allow auto-complete only for exact or high-confidence single-task matches.
- [x] Leave ambiguous or low-confidence matches unchanged.
- [x] Detect dismiss candidates but convert them into confirmation prompts instead of automatic state changes.

### Task 4: Extend `/new_thread` task surfacing
- [x] Update the `/new_thread` reply to include the previous-thread summary.
- [x] Include current active tasks in the same reply.
- [x] Include recently completed tasks in the same reply.
- [x] Ensure recently completed tasks are filtered correctly by caller and recency.
- [x] Keep normal turn behavior unchanged outside defined boundary checks.

### Task 5: Add tests for boundary behavior
- [ ] Add coverage for the first substantive user turn of a new session.
- [ ] Add coverage proving `/new_thread` sets pending reconciliation for the next substantive user turn.
- [ ] Add coverage for obvious single-task completion.
- [ ] Add coverage for ambiguous completion candidates that must not auto-complete.
- [ ] Add coverage for dismiss candidates that ask for confirmation.
- [ ] Add coverage proving non-boundary turns do not run reconciliation.

### Task 6: Update docs
- [ ] Add the high-level feature doc under `docs/plan/`.
- [ ] Update `README.md`.
- [ ] Update `src/memory/README.md` and `src/channels/README.md` when the feature ships.
- [ ] Document `docs/plans/` as the RALPHEX-aligned execution layer.
