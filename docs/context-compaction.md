# Context budget and idle compaction checkpoint

Baseline: `7e0bf94d820fd26c02d948fa8af5c4706f59cad6`, production source on
`restoration/2026-10-02-mini-pages`, release `release20261002-7e0bf94-mini-pages`.
Development checkout: `/workspace/goodkiddo-context`, branch
`feature/2026-10-02-token-context`. Historical `main` is not the integration base.
No production change, credential access, live Telegram trial or paid model call is part of this checkpoint.

## Verified limits and configuration

OpenCode's own model catalog identifies `space-bunny-free` with context **1,048,576**,
input **524,288**, output **524,288**, and zero token prices. Evidence is pinned to
[anomalyco/models.dev commit fd6fdfa](https://github.com/anomalyco/models.dev/blob/fd6fdfaee0679ba8a8a6ef29def6900751e1061f/providers/opencode/models/space-bunny-free.toml),
retrieved 2026-10-02; the entry was last updated 2026-09-23. The catalog is also at
[models.opencode.ai](https://models.opencode.ai/providers/opencode).
[OpenCode's documentation](https://opencode.ai/docs/zen/) lists this alias and the
models endpoint; `/zen/v1/models` lists IDs but does not expose context limits.
The legacy `/inference/openai/v1/models` could not be read in this environment.
The implementation pins the provider's published limits for the known OpenCode alias/routes;
it does not infer the window from `LLM_MAX_OUTPUT_TOKENS`.

The total cap is `min(context.windowTokens, 200000)`. Input must also fit the
published input ceiling and `total - LLM_MAX_OUTPUT_TOKENS`. With the approved
runtime reserve of **1800**, this means input budget **198200**, including all
system/prompt text, full injected summary/memory/TODO data, history, function names,
arguments, schemas/results and protocol overhead.

No exact tokenizer for the anonymous model is published. Text budgeting uses
serialized UTF-8 bytes plus conservative framing (1024 per request, 32 per message),
an upper estimate for byte/subword tokenization rather than characters divided by four.
Actual provider usage continues to settle the existing reservation and usage ledger.
This can retain fewer than 198200 actual text tokens; it never advertises an exact
model tokenizer. Unknown windows fail before HTTP and before spending.

For another model or a changed route, the integrator must provide the actual window
and an inspectable HTTPS metadata reference, bound to the configured model:

```dotenv
LLM_CONTEXT_WINDOW_TOKENS=<verified context window>
LLM_CONTEXT_METADATA_SOURCE=https://<official metadata or documentation>
LLM_MAX_INPUT_TOKENS=<verified separate input limit if lower>
```

The cap of 200000 is fixed; increasing the override cannot raise it. Output, call,
search, daily and monthly financial limits remain the existing settings. The public
free provider is unchanged. There is no fallback to another or paid model.

**Image blocker:** OpenCode confirms multimodal input but publishes neither this
anonymous model's image tokenizer nor its image-token formula. Base64 length is not
an image-token estimate. Images are therefore saved as before, but model calls with
images require a verified upper bound and a reference. This bound must cover EVERY
accepted PNG/JPEG/WebP up to 5 MiB, including image dimensions and `detail=auto`:

```dotenv
LLM_IMAGE_TOKEN_UPPER_BOUND=<verified maximum tokens per accepted image>
LLM_IMAGE_TOKEN_METADATA_SOURCE=https://<official evidence for that bound>
```

Do not guess a familiar OpenAI/Claude vision formula for this model. Until reliable
evidence exists, image calls fail with an explicit explanation. Text calls work.
This is a release consideration for the integrator because the baseline sent photos
without a model-specific token estimate. Tests use synthetic bounds only.

## History and source retention

The old 24-message window (the code's real limit) and 12000-character clipping are
removed. No extractive first-800-character digest is produced. Every new user and
assistant message is stored in full in `assistant_history_archive`; upgrading cannot
recover content already discarded by the old implementation.
On first upgrade the retained history is rebuilt from the available archive so the
first semantic pass consumes full old sources instead of trusting the old extractive
digest. Persisted per-chat state prevents re-expanding compacted chats on restart.

Before each foreground call, whole earlier messages are selected by their token cost.
The latest request, current tool exchanges and system/durable data are mandatory.
An explicit notice identifies omitted older whole messages and their archive tools.
An oversized mandatory request fails safely, with source/history preserved.
All metered callers, including brief-only research, use the final total-budget guard;
the HTTP adapter guards direct calls too. Research keeps its existing shared six-call
budget and isolation; no research/provider selection change is made here.

An oversized foreground tool result is stored as complete JSON under the current
chat's `/context/tool-results/` VFS path; the model sees a bounded source reference,
not arbitrary chopped phrases. Existing VFS byte/file quotas still apply. The
read-only `context_result_read` pages the exact JSON by character offset, including
very long single-line strings, so no middle text becomes unreachable through the
existing line-based reader. `history_read` resolves exact archive source IDs within
the current chat. Source reads remain subject to the same aggregate request budget.

Compaction does not remove the archive, explicit memory, TODOs, tasks or source files.
The existing deliberate `/clear` behavior still deletes history/archive/summary and
cancels in-flight context; it preserves VFS files, explicit memory and jobs. Generated
tool-result source files follow that same VFS retention policy and quota.

## Idle behavior, concurrency and recovery

An additive `assistant_compaction` table stores per-chat last user activity, generation,
attempted generation and claim status/token. Addressed messages, commands and buttons
reset the idle hour before asynchronous intake. Unaddressed group messages do not.
Replayed Telegram updates do not reset activity. Persisted state survives restart;
legacy histories with no recorded activity state get a one-hour startup grace period.

The existing worker checks for idle chats after normal queued/scheduled turns. No
external automation, separate service or interval making unconditional model calls
is created. A claim is persisted before calling the model. Repeated wakes and restarts
do not retry an unchanged successful, failed or ambiguous interrupted generation.
New user activity or genuinely changed source permits a future attempt.

The model receives a previous summary and labelled complete source segments with
IDs and offsets. Every segment must be processed before commit. The prompt asks for
facts with attribution, decisions, open tasks/questions, exact source URLs/paths,
uncertainty and cancellations. Validated JSON has facts/decisions/open_tasks/sources;
the application adds the durable original archive ID range. Subsequent summaries keep
the earliest source ID. The model is given no tools; source/summary instructions are
explicitly historical data, never active instructions or authorization.

Summary replacement and removal of summarized rows from the active history happen
in one SQLite transaction only if the claim token, generation, active chat and previous
summary still match. New activity aborts idle work; `/clear`, shutdown and cancellation
abort it too. A provider ignoring abort cannot commit stale output. A changed manual
summary invalidates commit. Source failure, invalid JSON, tool calls, token overflow
or exhausted budget leave the existing summary, active history and archive unchanged.

Large sources can require several bounded calls but share the normal per-task maximum
(six in the approved runtime), per-chat daily quota, monthly spend reservations and
usage accounting. If all segments cannot be summarized within that allowance, no
partial summary is committed. Failed/blocked attempts do not retry every idle hour;
future activity is required. A persisted `status` makes this inspectable locally.
The separate Whisper maximum of **$5 per month Asia/Tbilisi** is unchanged.
Compaction and its restart recovery never enqueue user progress/failure notifications.

## Integration and deployment handoff

Only integrator `01a0f11c-6c99-72cb-bca0-2866fe4650d0` may coordinate a production
deployment. Integrate the checkpoint onto the exact production baseline above, not
historical main. VFS browser and native PostHog work belong to the other workers;
preserve their changes when resolving shared agent/worker/config/store files.

Review the pinned model metadata and the image blocker before release. Do not change
credentials, prices, output/call limits or Whisper cap to work around a blocked call.
There is no mandatory override for the known `space-bunny-free` route. No schema
replacement is needed: the new table is created additively by `AssistantStore`.
Back up the existing private assistant database through the integrator's approved
procedure before release. Rollback should restore the prior executable without
deleting the new table or full archive; old code will resume its old history limits.

Mocked verification commands (Bun 1.3.11; no provider traffic):

```bash
bun test ./checks/*.check.ts checks/analytics src/assistant/core-state.test.ts src/assistant/core-safety.test.ts src/assistant/prompt-jobs.test.ts
bun x tsc --noEmit -p checks/tsconfig-assistant.json
bun x tsc --noEmit -p checks/tsconfig-file-checks.json
bun run build
bun run test
bun run typecheck
```

Verified checkpoint: **170 Bun checks pass**, including **23 context/compaction checks**,
existing voice ($5 cap), VFS, mini-pages, delivery, research, recurring jobs and analytics.
Both focused typechecks and the build pass.

The last two baseline-wide commands have pre-existing blockers, reproduced in a
separate exact-7e0bf94 checkout: Vitest runs 704 tests successfully but cannot import
`bun:test` in three existing assistant suites; global typecheck reports
`src/capabilities/browser/job.test.ts:49` TS2493 (empty mock tuple). The Bun assistant
suites are run directly above; the active application typecheck and build pass.
Detailed final verification counts and checkpoint SHA are in the completion handoff.
