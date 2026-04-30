# Feature: DB-Backed Active Tasks and Notes

## Summary
Add structured active task tracking on top of the existing per-caller memory system. Durable notes stay in the current `/memory/notes/*.md` wiki flow, while actionable work items move into a SQL-backed task store with explicit `active`, `completed`, and `dismissed` states. The agent loads active tasks into context on agent build and performs task reconciliation only at defined boundaries: the first substantive user message of a new channel session and the first substantive user message after `/new_thread`.

The task store also carries prepared-follow-up metadata so future workers can decide when a task deserves another look without changing today's simple task UX.

Related execution plans: [`../plans/db-active-tasks-and-notes.md`](../plans/db-active-tasks-and-notes.md) and [`../plans/10-Prepared-Follow-ups--nudgeable-tasks-v1.md`](../plans/10-Prepared-Follow-ups--nudgeable-tasks-v1.md).

## User cases
- A user tells the bot to remember a fact or decision so that it stays in durable notes and can be reused later.
- A user gives the bot one or more actionable items so that they become active tracked tasks instead of loose memory text.
- A returning user starts a fresh conversation so that the bot surfaces the current active tasks before continuing with the new request.
- A user reports that a task is finished so that the bot can automatically complete the obvious matching task without needing explicit task IDs.
- A user changes direction or abandons a task so that the bot proposes dismissal but still asks for confirmation before mutating task state.

## Scope
**In:**
- SQL-backed task storage scoped per caller
- Durable prepared-follow-up metadata on task rows: due time, next check time, bounded priority, loop type, source context/reference, last nudge time, nudge count, and snooze time
- Natural-language task creation, completion, dismissal, and active-task listing through agent tools
- Active-task prompt injection on every agent build
- Boundary-based task reconciliation on new channel session start and after `/new_thread`
- `/new_thread` replies that include current active tasks and recently completed tasks
- Documentation for both the feature plan and the RALPHEX execution plan

**Out:**
- Inactivity timeout-based session detection
- Slash commands for task management
- User-facing due-date, priority, recurrence, or task-assignment workflows
- Scheduled digests, proactive nudge delivery, browser watchers, evidence collection, or external sending/publishing/submitting
- Converting existing note Markdown into canonical task storage
- Automatic task dismissal without user confirmation

## Design notes
- Notes and tasks have different lifecycles and should stay separate. Notes remain file-backed long-form memory artifacts; tasks become structured SQL state.
- Active tasks are always visible to the agent through a compact prompt snapshot, but automatic reconciliation only runs at explicit boundaries to avoid noisy state changes on every incoming message.
- Auto-complete is allowed only for a single high-confidence match. Ambiguous or low-confidence matches remain unchanged.
- Dismissal is suggestion-only in v1. The agent may detect likely obsolete tasks, but it must ask before dismissing them.
- `/new_thread` still rotates the short-term conversation state and summarizes the old thread. It does not itself auto-complete or dismiss tasks; it only surfaces task status and sets up the next boundary check.
- Prepared-follow-up metadata is additive and backward-compatible. Existing task rows remain valid; nullable fields default to `null`, `priority` defaults to `0`, and `nudge_count` defaults to `0`.
- The supported loop types are `deadline`, `client_followup`, `decision`, `watch`, `continuation`, and `general`. These classify why a task may need follow-up, but no scheduler currently acts on them.
- The Telegram-facing task tools remain intentionally simple. Internal code can create tasks with metadata or update metadata later, while `task_add` still asks only for list name, title, and optional note.
- This feature is the persistence foundation for prepared follow-ups. It does not send proactive messages, collect fresh evidence, watch browser state, or choose when to nudge a user.
