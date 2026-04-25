# Feature: Scheduled Timers

## Summary
The agent can set, list, and cancel cron-like scheduled jobs on behalf of the user. A background scheduler runs inside the same process, fires due timers, executes the stored prompt via the LLM, and delivers results to the user's Telegram chat. Timers persist in the database and survive restarts.

## User cases
- A user asks the agent to remind them of standup at 9 AM every weekday so that they get a prompt without opening the app.
- A user sets a daily digest at 8 PM summarizing their tasks so that they get a recap even when they're not using the bot.
- An analyst sets a weekly report at 10 AM Mondays so that they receive automated insights without manual prompting.
- A user sets a one-shot timer ("in 2 hours") for a quick reminder so that the bot pings them at the right time.

## Scope
**In:**
- Natural language → cron expression parsing by the LLM (e.g. "every workday at 10 AM" → `0 10 * * 1-5`)
- `create_timer`, `list_timers`, `cancel_timer` LLM tools
- In-process background scheduler (every 60 seconds)
- Results delivered to the same Telegram chat as the timer creator
- SQL-backed timer persistence (survives restarts)
- Timezone support for display
- Error tracking: 3 consecutive failures → warning to user

**Out:**
- Timer persistence across bot redeploys with exact millisecond timing (best-effort 60s resolution)
- Timer management via direct user commands (all through LLM only)
- Timers for other channels (Telegram only for v1)
- Fan-out timers (one timer → multiple users)
- Timer chaining or dependencies between timers
- Rich notification formats (push, email, etc.)

## Design notes
- Cron expressions are evaluated in UTC internally. Display times are converted to the user's configured timezone.
- The background scheduler runs every 60 seconds. Timer execution is best-effort — if the bot is under load, a timer may fire slightly late.
- Each timer stores `chatId` at creation time so results always go to the right conversation.
- The LLM receives the stored prompt as a fresh user message — it can use all normal tools.
- Consecutive failure tracking is per-timer, reset on successful execution.
- The scheduler is started once when `telegramChannel.run()` initializes and stopped on graceful shutdown.

## Related
- [Execution plan: Scheduled Timers](../plans/scheduled-timers.md)
