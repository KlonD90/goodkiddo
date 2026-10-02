# Core restoration

The active agent now exposes chat-scoped `memory_list`, `memory_write`, `memory_delete`,
`history_search`, `save_context_summary`, `todo_add`, `todo_list`, and `todo_update`.
Records are committed to the assistant SQLite database before tools report success.
TODOs have open/done/dismissed states and author-only mutation; they do not imply a timer.
Memory records hold facts/preferences/skills and also require their author's permission to change.

The original checkpoint kept 24 messages and an extractive digest. [context-compaction.md](context-compaction.md)
adds opt-in expanded text budgeting and always-on idle semantic compaction; the
legacy foreground/vision input view remains available for compatibility. Complete available
source messages remain archived and searchable within their chat. Lasting facts should still
be saved explicitly; summaries and original sources remain historical data. The full injected
summary, notes and open TODOs count toward the aggregate request budget.

`/clear` deletes dialogue history, its archive and its summary, preserving explicit memory and
saved tasks. `memory_delete` removes a lasting note; `/forget_memory` also clears historical
dialogue copies. Checkpoint 2 adds the generation guard for `/clear` during a pending turn.
Checkpoint 2 updates Telegram `/privacy`, `/clear`, `/memory` and `/forget_memory KEY|all`.
Explicit record deletion also clears dialogue/summary copies and invalidates pending turns.
Deletion cannot recall already delivered Telegram messages or provider data. It does not erase
saved TODOs, reminders, files, job prompts/results or other participants' memory records.

## Integration

Base: deployed public inference/group fixes `d6e8997`, branch `restore-core-state`.
New tables live in `assistant-core-schema.ts`, so preserve the file worker's schema additions.
`AssistantStore` gains `memory` and `todos` plus archive/summary hooks in `remember`/`forget`.
The agent appends core tool definitions and dispatches core names before existing `executeTool`;
preserve the file worker's tool registry/dispatcher and any `delivery_hold` hooks in worker.
Checkpoint 1 did not touch ingress/worker/delivery. Checkpoint 2 adds focused hooks there.

## Checkpoint 2: commands, clear and scheduled delivery

Forwarded slash commands are source data; their agent requests receive only read/search tools.
Selected quotes use their actual speaker and timestamp. Incoming Telegram dates are carried
into history archives. `/clear` increments a persisted per-chat context version, aborts local
in-flight turns and cancels pending reply/document deliveries. Queued requests with an old
version are skipped; provider responses are checked again before tool execution and final save.
Already executed side effects and Telegram sends already in flight cannot be recalled.

Reminder/meeting results transition active → delivering → completed only when every chunk
succeeds. Permanent delivery failures become delivery_failed and remain visible in `/tasks`;
`/retry ID` / `retry_task_delivery` retries the saved result with no new LLM call. Cancellation
removes its pending deliveries. Transient failures retain delivering and use existing backoff.

When merging with file commit f86a24a:

- Preserve worker's `delivery_hold` creation, finally cleanup, and recovery filtering/cleanup.
- Preserve delivery's hold predicate, document dispatch and every `finishDocument` cleanup.
  Insert `finishScheduledDelivery(store, runId, status)` after the last-chunk decision and
  before analytics completion in the existing `finishDelivery` function.
- Keep the file worker's Telegram document types/ingress handling, adding date/quote/forward
  fields and `telegramRequestText` only to textual request construction.
- Keep file schemas. Companion core tables are initialized separately by AssistantStore.
- `discardRunDeliveries` cleans text links and, if the companion file delivery table exists,
  cancels queued document payloads and releases their bytes; it also clears delivery_hold.
- Keep file tool dispatch; core tools remain a separate agent dispatcher. `cancel_task` gains
  cancelJobDelivery; this small tools.ts hunk must be combined with file tool additions.

## Checkpoint 3: recurring prompt jobs

Tools: create_prompt_job, list_prompt_jobs, update_prompt_job, prompt_job_runs and
prompt_job_result. Commands: /jobs, /pause ID, /resume ID, /cancel ID. /tasks includes
ordinary TODOs and recurring jobs. Only the creator can edit/pause/resume/cancel a job.
Schedules use five cron fields with a single fixed minute and an explicit IANA timezone;
@hourly/@daily/@weekly/@monthly are accepted. Execution is at most hourly. A bounded
reverse check repairs cron-parser 5.5's verified spring-DST forward-iterator omission.

Each claimed occurrence has a durable stable run ID. Claiming advances the next time from
now and skips missed backlog. The same single worker services foreground requests first,
then due prompts. On restart, interrupted claimed/running turns become failed results once
rather than replaying provider calls; queued notifications do not rerun the provider.
Editing/pausing cancels outstanding results and pending notifications but preserves saved
results. After three failed executions the job pauses; resuming resets its failure count.

Per-run caps: 1–6 LLM calls, 0–3 searches, a 180-second deadline and 0–1 USD further
limited by configuration. Defaults use configured calls/searches and min(0.1 USD, monthly
budget), so the existing zero-cost deployment retains a zero-cost cap. LLM and search
reservations both count; owner/chat daily and monthly limits still apply. Provider-reported
charges can exceed configured estimates; later calls stop after that charge. No deployed
pricing, budgets, credentials or job data are changed by installing this capability.

Scheduled prompts support read/search/report tools, including current-chat virtual-file reads.
They cannot create further jobs, send arbitrary documents or mutate memory/TODOs/settings/files.
Full results (up to 48000 characters) persist separately from dialogue and remain available
through prompt_job_result even without notifications. Modes:

- verbose: full results and failures;
- summary: a short extractive success notification; full result remains saved;
- errors_only: failed executions only;
- silent: no notifications, including automatic pause; status remains visible in /jobs.

Cancellation stops future runs and retains results. /privacy discloses that /clear and
/forget_memory do not erase saved job prompts/results, files or TODOs. No bulk deletion,
retroactive provider/Telegram erasure, or extra LLM summary call is introduced.

### Additional merge requirements

- Keep worker's file delivery_hold creation/finally cleanup/recovery hooks. Its drain chooses
  inbox before claimPromptRequest. Scheduled turns use their own run ID, skip inbox-status
  writes/dialogue insertion, use bounded config and finishPromptTurn for results/notifications.
  Recovery skips prompt-run IDs in the ordinary loop, then calls recoverPromptTurns.
- Keep agent's core/file/stream hooks. Append promptJobToolDefinitions, dispatch those names,
  and check assertScheduledTurn around provider/tool boundaries. Scheduled requests append
  their saved prompt as a user message explicitly. tool-access.ts lists permitted read tools;
  merge newly restored read-only web tool names into that whitelist.
- The ONLY recurring change to delivery is store.promptJobs.finishDelivery(runId, status)
  beside finishScheduledDelivery after last-chunk reconciliation. Preserve the integrator's
  document dispatch/cleanup and ambiguous-delivery reconciliation implementation.
- Preserve core companion tables beside file schemas. AssistantStore gains promptJobs.
- tools.ts counts recurring jobs toward task quotas and passes run scope into search
  reservations; preserve file/web additions. budget.ts reserves and settles LLM scope too.
- Ingress adds promptJobCommand routing, taskOverview and accurate /help /privacy copy;
  preserve document/media intake. No active-entrypoint change is required: maintenance already
  wakes the worker. No real jobs are created or activated on startup.

Verification: `bun test src/assistant/core-state.test.ts src/assistant/core-safety.test.ts src/assistant/prompt-jobs.test.ts` uses temporary synthetic databases and
a fake provider. No live Telegram messages, recurring jobs, credentials or provider calls.
