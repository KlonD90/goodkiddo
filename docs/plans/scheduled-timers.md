# Plan: Scheduled Timers

## Overview
LLM tools that let the agent set, list, update, and delete cron-like scheduled jobs and one-time reminders on behalf of the user. Recurring timers reference a `*.md` memory file that contains the prompt to execute. One-time reminders store inline notification text and a direct `runAtUtc` timestamp, then disable themselves after the first successful send. A background scheduler runs inside the same process (in-process loop) checking for due timers, reads recurring prompts from the referenced md file, executes them via the LLM, and delivers results or reminders to the user's Telegram chat. Timers persist in the database so they survive restarts.

## DoD

**When** a user tells the agent to set a timer ("every workday at 10 AM give me latest news..."):

1. **Timer created** — valid cron expression, md file exists:
   - Agent calls `create_timer({ type: "always", mdFilePath, cronExpression, timezone })`
   - Bot first verifies the md file exists via `readMdFile(path)` — if not found, returns error: "Memory file not found: <path>"
   - Bot confirms: "Timer set. I'll run `/memory/<mdFilePath>.md` every workday at 10 AM."
   - Timer stored in DB with `id`, `user_id`, `chat_id`, `md_file_path`, `cron_expression`, `timezone`, `next_run_at`
   - `timerId` returned to agent for subsequent operations

2. **Timer fires** — background loop detects due timer:
   - Scheduler picks up the timer
   - Reads prompt text from the referenced `*.md` file in `/memory/`
   - LLM executes the stored prompt (same model/agent as normal turns)
   - Result sent to the user's Telegram chat (same `chat_id`)
   - `last_run_at` updated, `next_run_at` recomputed from cron

3. **Multiple timers due** — several fire at once:
   - Each runs independently
   - Each sends its own result to the same chat

4. **One-time reminder fires**:
   - Agent created it with `create_timer({ type: "once", message, runAtUtc })`
   - Scheduler sends `Reminder: <message>` directly to the user's Telegram chat
   - Timer is marked completed by setting `last_run_at` and `enabled = false`
   - Send failures are stored on the timer and retried on the next scheduler poll

5. **Timer execution fails** (LLM error):
   - Error logged
   - `last_error` stored on the timer record
   - `next_run_at` still updated for next occurrence
   - No user-facing error unless same timer fails 3x in a row (then notify user)

6. **User lists timers**:
   - Agent calls `list_timers()`
   - Bot replies with a list of active timers: `{ timerId, mdFilePath, cronExpression, nextRunAt, lastRunAt }`

7. **User updates a timer**:
   - Agent calls `update_timer(timerId, { cronExpression?, timezone?, enabled? })`
   - Bot confirms what changed
   - `next_run_at` recomputed if cron changed

8. **User deletes a timer**:
   - Agent calls `delete_timer(timerId)`
   - Timer hard-deleted from DB
   - Bot confirms: "Timer deleted."

9. **Invalid cron expression**:
   - `create_timer` returns error: "Invalid schedule. Try '0 10 * * 1-5' for every workday at 10 AM."
   - No timer created

10. **Referenced md file deleted** — file gone when timer fires:
   - Timer fires but `/memory/<path>.md` doesn't exist
   - Timer hard-deleted from DB
   - User notified in Telegram: "Timer for '/memory/<path>.md' was deleted because the memory file no longer exists."

**Architecture:**
- `src/capabilities/timers/` — scheduler, store, tools
- `src/capabilities/timers/store.ts` — SQL-backed timer persistence
- `src/capabilities/timers/scheduler.ts` — in-process background loop
- `src/capabilities/timers/tools.ts` — LLM tools (create, list, update, delete)
- Background loop runs every 60 seconds checking `next_run_at <= now AND enabled = true`

## Validation Commands
- `bun tsc --noEmit`
- `bun test src/capabilities/timers/*.test.ts` (new test file)
- `bun test src/channels/telegram.test.ts` (timer tools wired)

---

### Task 1: Define timer store interface
- [x] Create `src/capabilities/timers/store.ts` — `TimerStore` class
- [x] `TimerStore` constructor: `constructor({ db: SQL, dialect: 'sqlite' | 'postgres' })`
- [x] DDL: `CREATE TABLE timers (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, md_file_path TEXT NOT NULL, cron_expression TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'always', message TEXT, timezone TEXT NOT NULL DEFAULT 'UTC', enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_error TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`
- [x] Index on `(enabled, next_run_at)` for efficient due-timer queries
- [x] Methods: `create(params)`, `findDue()`, `findByUser(userId)`, `getById(id)`, `update(id, userId, updates)`, `delete(id, userId)`, `touchRun(id, nextRunAt)`, `touchError(id, userId, error, nextRunAt?)`
- [x] `create(params)`: recurring timers store `{ userId, chatId, kind: "always", mdFilePath, cronExpression, timezone, nextRunAt }`; one-time reminders store `{ userId, chatId, kind: "once", message, runAtUtc-derived nextRunAt }`; returns full timer record including `id`
- [x] `update(id, userId, updates)`: `{ cronExpression?, timezone?, enabled? }` → validates user ownership, updates only provided fields, recomputes `next_run_at` if cron changed
- [x] `delete(id, userId)`: hard deletes, validates ownership
- [x] `findDue()`: returns timers where `enabled = 1 AND next_run_at <= now`
- [x] `touchRun`: sets `last_run_at = now`, `last_error = null`, `consecutive_failures = 0`, updates `next_run_at`
- [x] `touchError`: increments `consecutive_failures`, sets `last_error`, and optionally updates `next_run_at`; one-time reminders omit `nextRunAt` so failed sends stay due for retry
- [x] All methods async, use Bun.sql tagged templates
- [x] Add `store.test.ts` with in-memory DB: create, find due, update cron, delete by owner, delete by non-owner rejected, touchRun resets failures, touchError increments counter

### Task 2: Implement background scheduler loop
- [x] Create `src/capabilities/timers/scheduler.ts` — `startScheduler(store, options)` function
- [x] Options: `{ intervalMs: 60_000, readMdFile(timer, path): Promise<string>, onTick(timer, promptText): Promise<void>, notifyUser(recipient, message): Promise<void> }`
- [x] Returns `{ stop(): void }` — clears interval
- [x] Loop: poll `store.findDue()`, for each recurring timer call `readMdFile(timer, timer.mdFilePath)`, then `onTick(timer, promptText)`; for one-time reminders send the stored message directly and disable the timer after success
- [x] If `readMdFile` throws (file not found): call `store.delete(timer.id, timer.userId)` and `notifyUser(timer.userId, "Timer for '/memory/<path>.md' was deleted because the memory file no longer exists.")`, then move to next timer (no retry)
- [x] After `onTick` success: call `store.touchRun(id, nextRunAt)` where `nextRunAt` is computed from cron expression
- [x] After `onTick` failure: `store.touchError(id, userId, message, nextRunAt)`; if `consecutive_failures >= 3` after increment: call `notifyUser(userId, warningMessage)`
- [x] Add `scheduler.test.ts` with mocked store and readMdFile: fires due timers, skips non-due, handles onTick errors, md file not found causes timer deletion and user notification (not retry)

### Task 3: Define LLM timer tools interface
- [x] Create `src/capabilities/timers/tools.ts` — `createTimerTools(store, options)` function
- [x] Options: `{ computeNextRun(cronExpression, fromDate?): number }` (pure function for computing next recurring run timestamp)
- [x] Returns an array of tool definitions compatible with the agent tool system
- [x] `create_timer(...)` — discriminated union keyed by `type`: `type: "always"` validates cron, timezone, and mdFilePath then verifies file exists via `readMdFile`; `type: "once"` accepts `message` and `runAtUtc`, stores `nextRunAt` directly from `runAtUtc`, and derives a UTC cron expression only for legacy storage/display
- [x] `list_timers()` — returns `{ timers: Array<{ timerId, mdFilePath, cronExpression, timezone, nextRunAt, lastRunAt, consecutiveFailures }> }`
- [x] `update_timer(timerId, updates)` — `updates: { cronExpression?, timezone?, enabled? }`, returns confirmation of what changed
- [x] `delete_timer(timerId)` — hard deletes, returns confirmation
- [x] Cron validation: use `cron-parser` or `cron-validate`; parse the expression and compute next run to validate
- [x] `create_timer` error cases: invalid cron → "Invalid schedule..."; mdFilePath doesn't match expected pattern → "Memory file path must be inside /memory/"
- [x] Add `tools.test.ts` with mocked store: create valid timer, create with missing file (error), create invalid cron, list timers, update timer cron, update non-owned timer rejected, delete timer, delete non-owned timer rejected

### Task 4: Wire timer tools into agent
- [x] Add `timerTools?: ReturnType<typeof createTimerTools>` to `CreateAppAgentOptions` in `src/app.ts`
- [x] In `createAppAgent`, merge `timerTools` into the tools array
- [x] Add `timerScheduler?: { start(store): { stop() } }` to `ChannelRunOptions` in `src/channels/types.ts`
- [x] In `telegramChannel.run()`, call `createTimerTools(store, options)` and pass the resulting tools to `createAppAgent` (deferred: createTimerTools call in Task 5 when TimerStore is created)

### Task 5: Wire scheduler into telegram channel and handle timer execution
- [x] In `telegramChannel.run()`, after session setup, call `scheduler.start(store, { readMdFile, onTick })`
- [x] `readMdFile(path)`: reads the memory file from the workspace backend at the given path, returns contents as string; throws if not found
- [x] `onTick(timer, promptText)`: receives the timer record and the text from the md file
- [x] On scheduler tick: use the current agent (same model/tools as normal turns) to invoke with `promptText` as user message
- [x] Stream the LLM reply to the user's `chatId` via `sendTelegramMessage`
- [x] Add `stop()` call to the channel shutdown sequence
- [x] Add `notifyUser` callback to scheduler: send a Telegram message to the user about repeated failures

### Task 6: Handle timezone for timer display and scheduling
- [x] Add `timezone: string` field to `AppConfig` in `src/config.ts` (default `"UTC"`)
- [x] Add to `.env` persistence pattern
- [x] When displaying next run time to user, convert from UTC to user's timezone
- [x] Cron expressions are evaluated in the timer's configured IANA timezone
- [x] For Telegram timer tools, `type: "once"` uses `runAtUtc` without timezone; `type: "always"` requires an explicit timezone, and recurring timers ask for timezone and save it to `/memory/USER.md` when it is not already known

### Task 7: Add telegram channel integration tests
- [x] Add test: timer fires → reads md file → LLM executes → result sent to correct chat
- [x] Add test: timer creation via agent tool call → timer stored in DB with correct fields
- [x] Add test: update timer via agent tool call → cron and next_run_at updated in DB
- [x] Add test: delete timer via agent tool call → timer removed from DB
- [x] Add test: delete non-owned timer → rejected with error
- [x] Add test: 3 consecutive failures → warning message sent to user
- [x] Add test: invalid cron → error returned to agent, no timer created
- [x] Add test: md file not found at execution → timer deleted, user notified
- [x] Mock the scheduler store, readMdFile, and LLM in tests

### Task 8: Docs and cleanup
- [x] Update `src/channels/README.md` to document timer feature, limits
- [x] Add `src/capabilities/timers/README.md` describing the scheduler, store schema, cron format, and how to add notification backends
- [x] Add a short note to `CLAUDE.md` pointing at the new docs
- [x] Add cron format cheat sheet: `0 10 * * 1-5` = every weekday at 10 AM, `*/15 * * * *` = every 15 minutes
