# Feature: DB-Backed Active Tasks and Notes

## Summary
Add structured active task tracking on top of the existing per-caller memory system. Durable notes stay in the current `/memory/notes/*.md` wiki flow, while actionable work items move into a SQL-backed task store with explicit `active`, `completed`, and `dismissed` states. The agent loads active tasks into context on agent build and performs task reconciliation only at defined boundaries: the first substantive user message of a new channel session and the first substantive user message after `/new_thread`.

## User cases
- A user tells the bot to remember a fact or decision so that it stays in durable notes and can be reused later.
- A user gives the bot one or more actionable items so that they become active tracked tasks instead of loose memory text.
- A returning user starts a fresh conversation so that the bot surfaces the current active tasks before continuing with the new request.
- A user reports that a task is finished so that the bot can automatically complete the obvious matching task without needing explicit task IDs.
- A user changes direction or abandons a task so that the bot proposes dismissal but still asks for confirmation before mutating task state.

## Scope
**In:**
- SQL-backed task storage scoped per caller
- Natural-language task creation, completion, dismissal, and active-task listing through agent tools
- Active-task prompt injection on every agent build
- Boundary-based task reconciliation on new channel session start and after `/new_thread`
- `/new_thread` replies that include current active tasks and recently completed tasks
- Documentation for both the feature plan and the RALPHEX execution plan

**Out:**
- Inactivity timeout-based session detection
- Slash commands for task management
- Due dates, priorities, recurrence, or task assignment
- Converting existing note Markdown into canonical task storage
- Automatic task dismissal without user confirmation

## Design notes
- Notes and tasks have different lifecycles and should stay separate. Notes remain file-backed long-form memory artifacts; tasks become structured SQL state.
- Active tasks are always visible to the agent through a compact prompt snapshot, but automatic reconciliation only runs at explicit boundaries to avoid noisy state changes on every incoming message.
- Auto-complete is allowed only for a single high-confidence match. Ambiguous or low-confidence matches remain unchanged.
- Dismissal is suggestion-only in v1. The agent may detect likely obsolete tasks, but it must ask before dismissing them.
- `/new_thread` still rotates the short-term conversation state and summarizes the old thread. It does not itself auto-complete or dismiss tasks; it only surfaces task status and sets up the next boundary check.
