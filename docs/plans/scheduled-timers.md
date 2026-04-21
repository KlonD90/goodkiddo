# Plan: Scheduled Timers

## Overview
LLM tools that let the agent set, list, update, and delete cron-like scheduled jobs on behalf of the user. Each timer references a `*.md` memory file that contains the prompt to execute. A background scheduler runs inside the same process (in-process loop) checking for due timers, reads the prompt from the referenced md file, executes it via the LLM, and delivers results to the user's Telegram chat. Timers persist in the database so they survive restarts.

## DoD

**When** a user tells the agent to set a timer ("every workday at 10 AM give me latest news..."):

1. **Timer created** — valid cron expression, md file exists:
   - Agent calls `create_timer(mdFilePath, cronExpression, timezone?)`
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

4. **Timer execution fails** (LLM error):
   - Error logged
   - `last_error` stored on the timer record
   - `next_run_at` still updated for next occurrence
   - No user-facing error unless same timer fails 3x in a row (then notify user)

5. **User lists timers**:
   - Agent calls `list_timers()`
   - Bot replies with a list of active timers: `{ timerId, mdFilePath, cronExpression, nextRunAt, lastRunAt }`

6. **User updates a timer**:
   - Agent calls `update_timer(timerId, { cronExpression?, timezone?, enabled? })`
   - Bot confirms what changed
   - `next_run_at` recomputed if cron changed

7. **User deletes a timer**:
   - Agent calls `delete_timer(timerId)`
   - Timer hard-deleted from DB
   - Bot confirms: "Timer deleted."

8. **Invalid cron expression**:
   - `create_timer` returns error: "Invalid schedule. Try '0 10 * * 1-5' for every workday at 10 AM."
   - No timer created

9. **Referenced md file deleted** — file gone when timer fires:
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
- [ ] Create `src/capabilities/timers/store.ts` — `TimerStore` class
- [ ] `TimerStore` constructor: `constructor({ db: SQL, dialect: 'sqlite' | 'postgres' })`
- [ ] DDL: `CREATE TABLE timers (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, md_file_path TEXT NOT NULL, cron_expression TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC', enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_error TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`
- [ ] Index on `(enabled, next_run_at)` for efficient due-timer queries
- [ ] Methods: `create(params)`, `findDue()`, `findByUser(userId)`, `getById(id)`, `update(id, userId, updates)`, `delete(id, userId)`, `touchRun(id, nextRunAt)`, `touchError(id, error, resetFailures?)`
- [ ] `create(params)`: `{ userId, chatId, mdFilePath, cronExpression, timezone, nextRunAt }` → returns full timer record including `id`
- [ ] `update(id, userId, updates)`: `{ cronExpression?, timezone?, enabled? }` → validates user ownership, updates only provided fields, recomputes `next_run_at` if cron changed
- [ ] `delete(id, userId)`: hard deletes, validates ownership
- [ ] `findDue()`: returns timers where `enabled = 1 AND next_run_at <= now`
- [ ] `touchRun`: sets `last_run_at = now`, `last_error = null`, `consecutive_failures = 0`, updates `next_run_at`
- [ ] `touchError`: increments `consecutive_failures`, sets `last_error`, does NOT update `next_run_at` (fires again next cycle)
- [ ] All methods async, use Bun.sql tagged templates
- [ ] Add `store.test.ts` with in-memory DB: create, find due, update cron, delete by owner, delete by non-owner rejected, touchRun resets failures, touchError increments counter

### Task 2: Implement background scheduler loop
- [ ] Create `src/capabilities/timers/scheduler.ts` — `startScheduler(store, options)` function
- [ ] Options: `{ intervalMs: 60_000, readMdFile(path): Promise<string>, onTick(timer, promptText): Promise<void> }`
- [ ] Returns `{ stop(): void }` — clears interval
- [ ] Loop: poll `store.findDue()`, for each timer call `readMdFile(timer.mdFilePath)`, then `onTick(timer, promptText)`
- [ ] If `readMdFile` throws (file not found): call `store.delete(timer.id, timer.userId)` and `notifyUser(timer.userId, "Timer for '/memory/<path>.md' was deleted because the memory file no longer exists.")`, then move to next timer (no retry)
- [ ] After `onTick` success: call `store.touchRun(id, nextRunAt)` where `nextRunAt` is computed from cron expression
- [ ] After `onTick` failure: `store.touchError(id, message)`; if `consecutive_failures >= 3` after increment: call `notifyUser(userId, warningMessage)` then reset counter
- [ ] Add `scheduler.test.ts` with mocked store and readMdFile: fires due timers, skips non-due, handles onTick errors, md file not found causes timer deletion and user notification (not retry)

### Task 3: Define LLM timer tools interface
- [ ] Create `src/capabilities/timers/tools.ts` — `createTimerTools(store, options)` function
- [ ] Options: `{ timezone: string, computeNextRun(cronExpression, fromDate?): number }` (pure function for computing next run timestamp)
- [ ] Returns an array of tool definitions compatible with the agent tool system
- [ ] `create_timer(mdFilePath, cronExpression, timezone?)` — validates cron and mdFilePath format, verifies file exists via `readMdFile`, creates timer, returns `{ timerId, nextRunAt, message }`; if file not found: returns error "Memory file not found: <path>"
- [ ] `list_timers()` — returns `{ timers: Array<{ timerId, mdFilePath, cronExpression, timezone, nextRunAt, lastRunAt, consecutiveFailures }> }`
- [ ] `update_timer(timerId, updates)` — `updates: { cronExpression?, timezone?, enabled? }`, returns confirmation of what changed
- [ ] `delete_timer(timerId)` — hard deletes, returns confirmation
- [ ] Cron validation: use `cron-parser` or `cron-validate`; parse the expression and compute next run to validate
- [ ] `create_timer` error cases: invalid cron → "Invalid schedule..."; mdFilePath doesn't match expected pattern → "Memory file path must be inside /memory/"
- [ ] Add `tools.test.ts` with mocked store: create valid timer, create with missing file (error), create invalid cron, list timers, update timer cron, update non-owned timer rejected, delete timer, delete non-owned timer rejected

### Task 4: Wire timer tools into agent
- [ ] Add `timerTools?: ReturnType<typeof createTimerTools>` to `CreateAppAgentOptions` in `src/app.ts`
- [ ] In `createAppAgent`, merge `timerTools` into the tools array
- [ ] Add `timerScheduler?: { start(store): { stop() } }` to `ChannelRunOptions` in `src/channels/types.ts`
- [ ] In `telegramChannel.run()`, call `createTimerTools(store, { timezone })` and pass the resulting tools to `createAppAgent`

### Task 5: Wire scheduler into telegram channel and handle timer execution
- [ ] In `telegramChannel.run()`, after session setup, call `scheduler.start(store, { readMdFile, onTick })`
- [ ] `readMdFile(path)`: reads the memory file from the workspace backend at the given path, returns contents as string; throws if not found
- [ ] `onTick(timer, promptText)`: receives the timer record and the text from the md file
- [ ] On scheduler tick: use the current agent (same model/tools as normal turns) to invoke with `promptText` as user message
- [ ] Stream the LLM reply to the user's `chatId` via `sendTelegramMessage`
- [ ] Add `stop()` call to the channel shutdown sequence
- [ ] Add `notifyUser` callback to scheduler: send a Telegram message to the user about repeated failures

### Task 6: Handle timezone for timer display and scheduling
- [ ] Add `timezone: string` field to `AppConfig` in `src/config.ts` (default `"UTC"`)
- [ ] Add to `.env` persistence pattern
- [ ] When displaying next run time to user, convert from UTC to user's timezone
- [ ] Cron expressions are always stored and evaluated in UTC internally; timezone is for display only
- [ ] For the timer tools, `create_timer` accepts an optional `timezone` override; defaults to `config.timezone`

### Task 7: Add telegram channel integration tests
- [ ] Add test: timer fires → reads md file → LLM executes → result sent to correct chat
- [ ] Add test: timer creation via agent tool call → timer stored in DB with correct fields
- [ ] Add test: update timer via agent tool call → cron and next_run_at updated in DB
- [ ] Add test: delete timer via agent tool call → timer removed from DB
- [ ] Add test: delete non-owned timer → rejected with error
- [ ] Add test: 3 consecutive failures → warning message sent to user
- [ ] Add test: invalid cron → error returned to agent, no timer created
- [ ] Add test: md file not found at execution → timer deleted, user notified
- [ ] Mock the scheduler store, readMdFile, and LLM in tests

### Task 8: Docs and cleanup
- [ ] Update `src/channels/README.md` to document timer feature, limits
- [ ] Add `src/capabilities/timers/README.md` describing the scheduler, store schema, cron format, and how to add notification backends
- [ ] Add a short note to `CLAUDE.md` pointing at the new docs
- [ ] Add cron format cheat sheet: `0 10 * * 1-5` = every weekday at 10 AM, `*/15 * * * *` = every 15 minutes
