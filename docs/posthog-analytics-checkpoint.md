# GoodKiddo PostHog analytics checkpoint — 2026-10-01

## Audit evidence (read only)

- Production `goodkiddo-bot.service` is active at `user@example.invalid`, working directory `/opt/goodkiddo/current/bot`, env file `/etc/goodkiddo/bot.env`.
- Both that env file and the actual running process environment contain **empty** `POSTHOG_PROJECT_KEY` and `ANALYTICS_SALT`. The active bot does not send PostHog events. Its existing code already had interaction, task and model usage hooks, but the configuration disables them.
- Nginx's serving origin `/opt/goodkiddo/current/landing/index.html` has an **empty** PostHog key and host `https://us.i.posthog.com`. Landing analytics is disabled. Its dormant JavaScript SDK initialization did not explicitly disable autocapture or replay. A public GET from the server received Cloudflare HTTP 403; the origin file was inspected instead, without executing the landing JavaScript.
- The separate legacy checkout `/path/to/goodkiddo has keys present in `bot/.env` and `landing/.env`, both with host `https://us.i.posthog.com`. No key values were printed, copied, configured or sent. Its old `bot_started`/`user_created` instrumentation lacks the current privacy filters and request lifecycle, so only the familiar `bot_started` name is reused.
- The already signed-in [PostHog project 399284](https://us.posthog.com/project/399284/settings/project-details) is named **Default project**, has a project token present, and is in **US Cloud**. Read-only settings show web autocapture, web vitals, session replay, replay console logs and network capture enabled. No settings were changed. Legacy token membership in this specific project has not been verified; deployment owner must select the correct existing token. The new landing never loads the SDK or remote settings, so these project defaults cannot turn collection on.
- Implementation was isolated in branch `analytics-posthog`, cloned from restoration commit `ac079c2` in `/path/to/goodkiddo The dirty restoration checkout, primary source checkout and production were not modified.

## Event taxonomy (schema_version=2)

All bot events include `app=goodkiddo_bot`, `is_test`, `audience=internal|external`, `bot_version`, pseudonymous chat ID/type, a stable `$insert_id`, `$process_person_profile=false`, `$geoip_disable=true`, and the original event timestamp. User and chat IDs retain the existing HMAC-SHA256 scheme (16 hex characters, `u_`/`c_` prefixes); task IDs now use the same scheme with `t_`. The salt must remain stable. Event names, property names, enum values and numeric values are allowlisted; model/provider labels are bounded and cannot be URLs.

| Event                                        | When / useful properties                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------ | ----------------------------- | -------------------------------------------------------------------------------------- |
| `bot_interaction`                            | Addressed human message, command, reply, mention or button. `interaction_type`; counts active humans, including commands and unsupported attachment attempts. Ignored group chatter and bot senders are excluded.         |
| `bot_started`                                | An explicit, non-forwarded `/start` command. `source=landing_nav                                                                                                                                                          | landing_hero                                                 | landing_meet | landing_dm | landing_steps                                                                                                                                                                                                                                                                                                                                                       | landing_final | direct | unknown`, `entrypoint=private | group`. Arbitrary start payloads map to `unknown`; raw payloads are never transmitted. |
| `request_accepted`                           | A non-command request persisted in the inbox. Queue-busy/unsupported attachments/stored-only uploads do not count. Telegram update retries reuse the same insert ID. Acceptance means queued, before later budget checks. |
| `task_started`                               | Worker starts a request or a scheduler starts an autonomous send. `task_id`, `task_type`, `initiator=user                                                                                                                 | bot`.                                                        |
| `task_completed`                             | Run finalizes once, retaining the existing delivery lifecycle hook. `status=success                                                                                                                                       | error                                                        | refused      | timeout    | cancelled`, `initiator`, `task_type`, `duration_sec`, `llm_calls`, `tokens_in`, `tokens_out`, `cost_usd`, optional bounded `error_type`. Duration starts when work begins and includes delivery, not queue wait. Conversation replies count as successful requests, not verified real-world task outcomes. The integration worker owns delivery ledger correctness. |
| `llm_usage`                                  | One metered model attempt, including ambiguous failures. `task_id`, safe `model`/`provider`, input/output tokens, cost, `usage_estimated`. Estimated usage/cost retains conservative reservations and is not an invoice.  |
| `tool_usage`                                 | One model-requested tool attempt. `task_id`, allowlisted `tool_name` (unrecognized names become `unknown`), `status=success                                                                                               | error`. No arguments, results, call IDs, URLs or file paths. |
| `bot_added_to_chat`, `bot_removed_from_chat` | Membership transitions with pseudonymous chat identity; do not count these chat identities as active users.                                                                                                               |

Landing sends only `landing_pageview` and `landing_cta_clicked`. Properties are `app=goodkiddo_landing`, `schema_version=2`, `is_test`, static `page_path=/`, random browser `distinct_id=l_<uuid>`, insert ID and the two privacy flags. CTA adds only allowlisted `cta_location`, `destination=private|group` and `source` matching the existing Telegram start parameter. A random identifier is kept in localStorage; denied storage falls back to a page-scoped identifier. There are no cookies, SDK, replay, autocapture, device fingerprint, arbitrary URL/query/referrer/UTM properties, surveys, feature flags or identity aliases. Fetch omits credentials and referrer. DNT, Global Privacy Control and `?draft` disable landing analytics before any identifier is stored.

`/privacy` and the landing privacy section disclose the collection, HMAC IDs, separate random browser ID and excluded content. PostHog still receives transport metadata such as the connection IP and HTTP user agent; GeoIP enrichment is disabled. These pseudonyms are not claimed to be anonymous and browser/Telegram identities are not joined.

## Dashboard recipes

Use `schema_version=2`, `is_test=false` everywhere. Exclude `audience=internal` for external bot usage. Do not rely on PostHog person profiles: these events intentionally disable them.

- **DAU:** unique `distinct_id` on `bot_interaction`, `app=goodkiddo_bot`, external audience, grouped by day. This definition measures human interaction, including commands; use unique `request_accepted` users for requesting-user DAU instead.
- **WAU:** unique users on the same event within a rolling seven-day window, not the sum of daily uniques. Set the insight timezone explicitly.
- **Accepted requests:** total `request_accepted`. **Started:** `task_started` filtered `initiator=user`. **Completed:** `task_completed`, `initiator=user`, `status=success`. **Failed:** statuses `error` and `timeout`; show `refused` (limits) and `cancelled` separately. Scheduled `initiator=bot` sends are a separate series. Use unique `properties.task_id` for started/finalized counts when validating transport deduplication.
- **Duration:** median/p95 `duration_sec` on user-initiated `task_completed`, breakdown by status; token/cost sums or averages on the same event provide per-request aggregates.
- **Models/tools:** count `llm_usage` by model/provider, sum tokens/cost with `usage_estimated` breakdown; count `tool_usage` by tool_name/status. Do not sum both completion aggregates and llm_usage into the same cost total.
- **Landing funnel:** a normal same-browser funnel `landing_pageview → landing_cta_clicked`, optionally breakdown by destination/source. **Attributed starts:** count `bot_started` by allowlisted source/entrypoint. Compare CTA and start counts for the same source/destination as aggregate conversion. A same-person landing→Telegram funnel is intentionally unavailable: stable browser random IDs and server HMAC user IDs are unrelated. Group membership updates alone cannot recover a start source; `/start landing_*` supplied by Telegram is the attribution signal. Starts can be repeated or links shared, so this is not guaranteed first-user acquisition.

Example HogQL for DAU (same filters apply to the other insights):

```sql
SELECT toDate(timestamp) AS day, count(DISTINCT distinct_id) AS dau
FROM events
WHERE event = 'bot_interaction'
  AND properties.app = 'goodkiddo_bot'
  AND properties.schema_version = 2
  AND properties.is_test = false
  AND properties.audience = 'external'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY day ORDER BY day
```

Rolling WAU snapshot replaces `toDate(timestamp)` grouping with one `count(DISTINCT distinct_id)` and a seven-day range. These recipes have not been executed against production; no new events exist there yet.

## Failure isolation and validation

Event building/storage and SDK initialization cannot throw into request acceptance, generation or delivery. Core run/budget/delivery state is still persisted even with analytics disabled. SDK network sends run in a single-flight background promise instead of being awaited by the delivery maintenance loop; requests are bounded to a three-second timeout, no SDK retries. The local outbox retains failed uploads and uses original timestamps plus stable insert IDs. It is capped at 10,000 events (new events may be dropped beyond this cap). Delivery is at least once with stable dedup IDs, not a promise of network-level exactly once. Pre-v2 payloads are not backfilled. Failures log only a generic deferred-delivery message, never errors/bodies/secrets.

The new unit tests were run failing first, before implementation. All test clients and landing fetches are local mocks, with synthetic credentials and `is_test=true`; no capture request was sent to real PostHog. Tests cover payload/value exclusion, ID stability, deduplication, accepted vs command events, start allowlist, retries/event time, failed analytics storage, SDK constructor failure, single-flight stalled upload with successful bot delivery, model/tool aggregates, landing CTA metadata, disabled/DNT/GPC/draft cases, blocked storage and failed transport. Validation results:

- `bun run test:analytics`: 11 passed, 51 assertions.
- `bun test src/assistant/core-safety.test.ts src/assistant/core-state.test.ts`: 19 passed, 80 assertions.
- `bun test ./checks/assistant-documents.check.ts ./checks/assistant-media.check.ts ./checks/assistant-files-integration.check.ts`: 18 passed, 145 assertions.
- `bun run typecheck`, `bun run build`, and `git diff --check`: passed.
- Required `bun run test` (legacy Vitest): 55 test files passed / 12 failed, 509 tests passed / 150 failed. Exact same totals on unmodified `ac079c2` in an isolated baseline worktree with the same dependencies. Failures are the absent `better-sqlite3` native binding for the installed Node runtime and pre-existing `bun:test` imports under Vitest. New analytics tests live in `checks/analytics` and have a dedicated Bun script, matching the active runtime checks; they introduce no extra Vitest failures. Logs: `/tmp/goodkiddo-posthog-vitest.log` and `/tmp/goodkiddo-posthog-vitest-baseline.log`.

## Exact activation handoff / blockers

This branch adds instrumentation but deliberately does not activate or deploy it. Production bot and landing remain disabled.

1. Integrator cherry-picks the implementation commit onto the final restoration integration and runs the bot checks together with that worker's delivery changes. No worker/delivery/scraper changes are included here.
2. Deployment owner confirms the intended existing US project token (legacy keys exist but were not copied), sets `POSTHOG_PROJECT_KEY` and `POSTHOG_HOST=https://us.i.posthog.com` in the production bot environment, and supplies an approved permanent random `ANALYTICS_SALT`. Do not create or persist a new salt/key/account without the requested approval/handoff; no salt was generated here. Changing the existing salt would split users. Internal test/user/chat IDs should be configured in the existing audience settings before activation.
3. Landing assets are outside the bot repo in the parent task. Copy this checkpoint's `landing-v2/index.html`, `analytics.js` and `analytics-config.js` into that landing source, preserving the existing image/font assets and other concurrent edits. Put only the confirmed existing **public project token** in `analytics-config.js`; no personal/secret API key. The default key is empty and testMode=false. Keep bot and landing on the same intended project/host.
4. Integrator owns production deployment/restart. An optional staging smoke check must set `ANALYTICS_TEST_MODE=true` / landing `testMode=true`, use a distinct test marker and exclude it from production insights. Then observe a naturally occurring permitted external interaction after activation; verify schema_version=2 and payload exclusions in the intended project without printing keys. No synthetic production events were generated during this audit.

No dashboard or settings changes were made. Current blockers are existing-token/project selection, permanent salt provisioning approval/handoff, integration/deployment, and post-activation ingestion verification. Code alone cannot produce historical DAU/request counts for the period when capture was disabled.
