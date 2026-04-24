# Scheduled Timers

LLM-powered scheduled jobs that run memory file prompts on cron schedules or
send one-time reminder notifications to the user's Telegram chat.

## Overview

Timers let the agent execute recurring tasks or one-time reminders on behalf of
the user. Recurring timers reference a `*.md` memory file containing the prompt
to run. One-time reminders store inline notification text and a direct
`next_run_at` timestamp derived from `runAtUtc`. A background scheduler runs
inside the same process, checking for due timers, reading recurring prompts
from the referenced file, executing them via the LLM, and delivering results or
reminders to the user's Telegram chat.

## Store Schema

Timers persist in a `timers` table:

```sql
CREATE TABLE timers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    md_file_path TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'always',
    message TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at BIGINT,
    last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    next_run_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);
```

Index on `(enabled, next_run_at)` for efficient due-timer queries.

## Scheduler

The scheduler runs as an in-process background loop started by the Telegram
channel during normal bot startup (see `scheduler.ts`):

- Polls every 60 seconds for timers where `enabled = 1 AND next_run_at <= now`
- For each due timer: reads the memory file, executes the prompt via LLM, sends result to Telegram
- On success: updates `last_run_at`, resets failure count, recomputes `next_run_at` in the timer's timezone
- On failure: increments `consecutive_failures`, stores error message, recomputes `next_run_at` in the timer's timezone
- For one-time reminders: sends `Reminder: ...` directly to Telegram, then marks the timer completed by disabling it and setting `last_run_at`
- After 3 consecutive failures: notifies user via Telegram
- If memory file not found when timer fires: deletes timer and notifies user

## LLM Tools

The timer tools are defined in `tools.ts` and provide:

- `create_timer(type, ...)` — create a recurring timer or a one-time reminder
- `list_timers()` — list all timers for the current user
- `update_timer(timerId, updates)` — update cron, timezone, or enabled state
- `delete_timer(timerId)` — permanently delete a timer

## Cron Format

Use `type: "always"` for recurring cron timers and `type: "once"` for one-time
reminders. Recurring timers use `cronExpression` and `timezone`; one-time
reminders use `runAtUtc`, store that timestamp directly as `next_run_at`, derive
a UTC cron expression only for legacy display/storage, and are disabled after
the first successful send.

Cron expressions use the format: `minute hour day-of-month month day-of-week`
and are evaluated in each timer's configured IANA timezone. Telegram timer
creation requires an explicit IANA timezone from the current request or from
`/memory/USER.md` for wall-clock and recurring schedules. For duration-only
one-time reminders like "in 5 minutes" or "in 30 minutes", the agent uses the
current Telegram message timestamp to compute `runAtUtc` instead of asking for
the user's timezone. If a wall-clock or recurring timer is missing a timezone,
the agent asks for it and saves it to `USER.md` before creating the timer. The
current Telegram message timestamp is prepended to the user turn as message
metadata so relative requests can be converted without changing the cacheable
system prompt.

### Cheat Sheet

| Expression | Meaning |
|------------|---------|
| `0 10 * * 1-5` | Every weekday at 10 AM |
| `*/15 * * * *` | Every 15 minutes |
| `0 9 * * *` | Every day at 9 AM |
| `0 18 * * 1-5` | Every weekday at 6 PM |
| `30 8 1 * *` | First day of month at 8:30 AM |
| `0 */2 * * *` | Every 2 hours |
| `0 10,14 * * 1-5` | Weekdays at 10 AM and 2 PM |

## Adding Notification Backends

The scheduler accepts a `notifyUser` callback in its options:

```typescript
interface SchedulerOptions {
    intervalMs: number;
    readMdFile: (timer: TimerRecord, path: string) => Promise<string>;
    onTick: (timer: TimerRecord, promptText: string) => Promise<void>;
    notifyUser: (userId: string, message: string) => Promise<void>;
}
```

To add a new notification backend (e.g., Discord, Slack, email):

1. Implement a `notifyUser(userId, message)` function for your backend
2. Pass it to `startScheduler()` when initializing the scheduler

The Telegram channel implementation uses `sendTelegramMessage` to notify users. Other backends should follow the same interface signature.

## Limits

- Memory file path must be inside `/memory/` directory
- Paths with `..` are rejected for security
- Cron expressions are validated via `cron-parser`
- Timezones must be valid IANA timezone names such as `UTC` or `America/New_York`
- Timers are user-scoped: users can only see/modify their own timers
- After 3 consecutive failures, a warning is sent to the user
- If the referenced memory file is deleted, the timer is automatically removed
