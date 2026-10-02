# Telegram assistant: implementation notes

## Product scope

This is the first single-agent runtime for the 2026-09-29 GoodKiddo handoff. Both private requests/reminders and group meeting coordination are implemented. It has no owner/reviewer/arbiter loop. Provider choice is intentionally configuration-only.

Included: a bounded tool-calling agent, current web search through Brave, supplied public URL reading, PDF/CSV/XLSX extraction, chat-scoped configured-model image understanding, native rich tables and streamed replies, text answers/reports with sources, persistent one-time reminders, group availability collection, a reminder before the deadline, final tally, cancellation, chat timezone and context, usage limits, optional PostHog events.

Optional static mini-pages are restored through `publish_page`, `list_pages` and `revoke_page`; see [mini-pages-restoration.md](mini-pages-restoration.md). Not included: arbitrary user-code execution, interactive mini-apps, ticket inventory, bookings, payments, participant enumeration, automatic private messages to group members. Search returns current snippets and links, not independently verified live inventory. Users must supply concrete options/deadlines; the agent asks for missing details.

## Entry points and boundaries

| Module                                    | Responsibility                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `src/app/telegram-assistant.ts`           | Startup, polling, worker/scheduler lifecycle, graceful shutdown            |
| `src/app/assistant-lock.ts`               | One local process per assistant database                                   |
| `src/channels/telegram-assistant-api.ts`  | Typed Telegram HTTP transport, with bounded timeouts and no raw error URLs |
| `src/assistant/ingress.ts`                | Addressed messages, commands, membership and callback processing           |
| `src/assistant/worker.ts`                 | Persistent request queue, turn accounting and recovery                     |
| `src/assistant/agent.ts`                  | One model tool loop with a bounded number of calls                         |
| `src/assistant/tools.ts`                  | Reminder, meeting, search and chat-scoped task operations                  |
| `src/assistant/meetings.ts`               | Availability buttons, votes, missing participants and tally                |
| `src/tasks/assistant-scheduler.ts`        | Due reminders, meeting reminders and final results                         |
| `src/assistant/delivery.ts`               | Durable outbound queue, backoff and delivery completion                    |
| `src/persistence/assistant-*`             | SQLite schema and storage                                                  |
| `src/providers/assistant-*`               | Replaceable LLM API and search adapter                                     |
| `src/integrations/assistant-analytics.ts` | Server-side analytics with an explicit property allowlist                  |

The new database is `store/assistant.db`. Existing `store/messages.db`, legacy sessions and unfinished local edits are not migrated or overwritten. Legacy runtime files remain available through explicit legacy scripts.

## Runtime behavior

Polling persists accepted requests before advancing the Telegram update offset. A single worker processes LLM requests serially; timers, votes and ordinary commands continue independently. A maximum of 100 queued requests bounds backlog. LLM turns have a 180-second deadline, individual requests 90 seconds, and configurable call/output caps.

Reminder/meeting creation is synchronous and durable. Repeating identical creation arguments within one turn uses a stable origin key, returning the existing job. A restart preserves saved jobs, votes, queued requests and outbound messages. A running LLM turn is marked interrupted rather than blindly replayed; users are directed to `/tasks` before retrying. The single-process lock is released on shutdown and stale process locks are reclaimed on startup.

Outbound messages are retried with exponential backoff; Telegram 429 respects `retry_after`, 403 deactivates the chat. Each chat's messages remain in order. If the process dies after Telegram accepted a send but before SQLite recorded it, a duplicate is possible: Telegram's sendMessage API has no idempotency key. Delivery is at least once, not an exactly-once promise.

Deadlines and one-time reminders use explicit ISO timestamps with offsets, then UTC storage. `/timezone` controls conversational interpretation/display. On restart, overdue jobs are processed immediately. Ties and zero-response meetings are reported honestly; unknown participants are never counted as consenting. Explicit participant handles identify whom to remind, not an access restriction on group members voting. Only task creators can cancel their tasks. Group timezone/context commands require Telegram administrator status.

## Analytics and costs

Events: `bot_interaction`, `bot_started`, `request_accepted`, `task_started`, `task_completed`, `llm_usage`, `tool_usage`, `bot_added_to_chat`, `bot_removed_from_chat`. Both server and landing use explicit event/property/value allowlists, pseudonymous IDs and disabled person profiles/GeoIP. Analytics remains optional, bounded, and isolated from delivery failures. See [PostHog audit, event definitions, dashboard recipes and activation handoff](../src/integrations/assistant-analytics.ts).

`task_completed` is guarded by stored run status so finalization happens once locally. Scheduled sends are separate `initiator=bot` runs. Successful runs finish after all outbound chunks are delivered. SDK delivery retries use a stable `$insert_id`; network-level exactly-once analytics delivery is not guaranteed.

Conversational turns begin as `task_type=other`; a tool can refine the completion's type to reminder, meeting or research. Clarification-only replies currently count as conversational completions. Before using these events as the handoff's strict “successful real-world task” KPI, separate conversational turns from end-to-end jobs in analytics. The external full event spec mentioned by the handoff was not supplied with the repository.

PostHog is optional until its project key and permanent salt are configured. The salt must not be rotated after launch. No real PostHog events were sent during implementation.

Usage is measured after every attempted LLM call. Missing usage/network uncertainty uses a conservative reservation with `usage_estimated=true`. Pricing is configuration, not hardcoded model claims. The local monthly ceiling includes configured search cost; per-task LLM cost properties report LLM spend. Provider-side hard caps must be configured in the chosen provider account. Any token-cache discount is conservatively ignored unless the provider returns authoritative cost. The stable system prefix/history can benefit from providers with automatic prefix caching, but no provider-specific cache API is assumed.

## Data and operation

Only addressed group messages enter model context. There is no message-count or per-message history clipping limit. The complete request fits min(verified model window, 200,000), with the configured output reserve inside that window. Whole older messages are selected by a conservative token budget and remain searchable in the full chat-scoped archive. After one idle hour a bounded model call produces a semantic summary; the original archive remains intact. Unknown model/image token limits prevent the call. See [context-compaction.md](context-compaction.md) for metadata, accounting and restart behavior. Processed inbox request bodies are erased; pending request bodies stay until processing. Completed jobs, votes and usage metadata remain in the local database. `/clear` removes conversational context and its archive, not the job archive. Backups of this database contain private data.

Set valid Telegram credentials, a provider/model with function calling, actual token prices, timezone and optional Brave/PostHog credentials before starting. Changing `src/config/assistant-config.ts` does not alter the existing private `.env`. No production deployment or macOS service re-enablement is part of this implementation.

Per the user's instruction, automated tests, type checking, builds, live bot trials and agent reviews were not run for this change.

## API references

- [Telegram Bot API](https://core.telegram.org/bots/api): updates, inline keyboards, callbacks and sends.
- [OpenRouter Chat Completions schema](https://openrouter.ai/docs/api_reference/overview): the compatible adapter's request/tool/usage shape; this does not select OpenRouter as the provider.
- [Brave web search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started): search results and links.
- [PostHog Node SDK](https://posthog.com/docs/libraries/node): server-side event client.

# Web/media restoration

The connected runtime restores bounded supplied-URL reading, PDF/CSV/XLSX extraction, chat-scoped image understanding, native Telegram rich tables, private draft streaming and durable group preview edits. See [web-media-runtime.md](web-media-runtime.md) for configuration boundaries, delivery semantics, synthetic checks and the remaining voice requirement. File tool dispatch and document delivery holds remain in force. A final new-send timeout is retained as an uncertain receipt and is not automatically resent.

Telegram voice now has an optional bounded OpenAI `whisper-1` intake with a persisted $5 monthly maximum in Asia/Tbilisi, owner cancellation and restart deduplication. It remains disabled until its existing OpenAI credential is configured. See [telegram-voice.md](telegram-voice.md); that implementation supersedes the earlier local-recognizer proposal in the media notes.
