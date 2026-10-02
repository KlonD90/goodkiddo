# Context budget and semantic compaction handoff

Exact development baseline: `7e0bf94d820fd26c02d948fa8af5c4706f59cad6`, on
`restoration/2026-10-02-mini-pages`, release `release20261002-7e0bf94-mini-pages`.
Branch: `feature/2026-10-02-token-context`. Historical main is not the integration base.
VFS browser/native analytics release `a679944` is maintained separately by the integrator.
This branch does not replace that release or duplicate its features.

The owner has accepted an approximate 200000-token budget with margin, provider usage
feedback, working images and full source retention. The previous pending approval for
this compromise is superseded. Production rollout remains the responsibility of
integrator `01a0f11c-6c99-72cb-bca0-2866fe4650d0`; no deployment, credential access,
Telegram trial or model generation call was performed in this checkout.

## Activation and defaults

Enable the completed expanded text path explicitly:

```dotenv
LLM_TEXT_CONTEXT_BUDGET_ENABLED=true
```

Its code default stays **false**, for reversible integration. Idle compaction remains
active for known-window models with either flag value. Pressure compaction is enabled
by the same text flag; there is no separate scheduler/service/automation or retry flag.
Keep these existing approved values (also their code defaults), without increasing them:

```dotenv
LLM_MAX_OUTPUT_TOKENS=1800
LLM_MAX_CALLS_PER_TASK=6
```

Do not change provider, credentials, configured prices, monthly/daily quotas, search
limits or the separate Whisper maximum of **$5 per month Asia/Tbilisi**. No paid
provider fallback is added. This handoff does not request any new credentials.

## Published model limits and the explicitly approximate estimator

The current pinned [models.dev Space Bunny entry](https://github.com/anomalyco/models.dev/blob/1af490fab48e51f098eb79d4cdf57802b04d251f/providers/opencode/models/space-bunny-free.toml)
records context **1048576**, input/output **524288**, multimodal input and zero catalog
prices. The limits are bound to the known `space-bunny-free` OpenCode routes.
[Inference documentation](https://opencode.ai/v2/docs/console/inference/) gives the
working metadata endpoint `/inference/v1/models`; it lists IDs, not tokenizer/window
metadata. The catalog still describes the model as anonymous. The owner's
MiniMax M3.1 Flash lead was checked; no official alias/tokenizer binding was established.
This implementation does not guess its hidden model or use another provider's credentials.

Total budget is `min(model window,200000)`; input is also limited by the published
provider input ceiling and `total - max output`. The approved configuration therefore
allows **198200 estimated input tokens**, with **1800 reserved inside** the 200000 total.
All system/prompt/durable summary/memory/TODO text, history, tool names, arguments,
schemas and results count. Images with a verified bound count separately as below.

`js-tiktoken@1.0.21` is an exact dependency/lockfile pin. Only its local `o200k_base`
ranks are imported and bundled; no tokenizer network fetch occurs at runtime.
The estimator is explicitly named **`o200k_base_proxy_128_v1`**, not a native Space
Bunny tokenizer. Token-looking user strings are ordinary data. Counting uses Unicode-safe
128-character windows to bound JS BPE work on huge words; this can add boundary overhead.
Submitted/source text is unchanged. Counts are cached with serialization checks, so
mutated messages/schemas cannot reuse stale counts. This is tokenization, not bytes=token.

Raw estimate = BPE counts of serialized messages and tool schemas + **1024 request
framing** + **32 per message**. Estimated text input = `ceil(scale * raw estimate)`.
The initial scale is **1.25**. Valid complete text-only `usage.prompt_tokens` observations
raise it to `max(previous,1.25,1.1*actual/raw)`; it never decreases. Cached input remains
part of context. The scale and estimator kind persist in `assistant_state` under a
hashed endpoint/model/estimator scope, without source text. Restart retains calibration;
model/route/estimator changes cannot reuse another scope's calibration. Missing, invalid
or image-bearing usage does not calibrate the text proxy.

**Limitation:** neither this proxy nor usage received after a call guarantees the native
model's first-request token count. A provider overflow error protects the provider's
larger window, not our 200000 ceiling. The owner accepted this practical estimate.
No exact-token or measured Space Bunny Russian utilization claim is made.

For a different/unknown model, verified window configuration remains required when the
text flag is enabled:

```dotenv
LLM_CONTEXT_WINDOW_TOKENS=<verified window>
LLM_CONTEXT_METADATA_SOURCE=https://<inspectable official evidence>
LLM_MAX_INPUT_TOKENS=<separate input limit if lower>
```

No overrides are required for the known configured Space Bunny route. Unknown-window
strict calls fail before HTTP/spending; flag-off baseline startup is preserved. The
fixed cap cannot be raised by an override. Idle failure preserves all source context.

## Two semantic compaction triggers

**Idle:** one hour without addressed user activity in that chat, after normal worker
queue processing. Messages, commands and buttons reset activity before async intake;
unaddressed group messages and duplicate updates do not. Persisted activity survives
restart; legacy sources receive a one-hour startup grace period.

**Pressure:** before each expanded foreground model call, the entire prospective
request is checked BEFORE selecting a bounded history suffix. At **95% of the input
budget** (188290 estimated input with the approved reserve), semantic compaction is
attempted. This also covers a prospective request already exceeding the total cap;
it does not wait for provider rejection. After success the foreground request uses
the fresh attributed semantic summary and refreshed active history. The latest user
request and live assistant/tool exchanges remain mandatory.

Both triggers share the same additive `assistant_compaction` state, generation guard
and claim token. The additive `trigger` column distinguishes idle/pressure outcomes.
A concurrent wake cannot steal a running claim, even after new activity changes its
generation. Success, failure and interrupted attempts are not replayed for unchanged
context, including after restart. New source/activity permits a later attempt.

The model receives labelled COMPLETE source segments with IDs and UTF-16 offsets,
plus the prior summary. Every segment must be processed before a commit. Segment
sizes/batches use the same calibrated BPE budget. Validated JSON retains facts with
attribution, decisions, open tasks/questions and original URLs/paths; the application
adds the earliest/latest full archive IDs. Source/summary instructions are untrusted
historical data. No tools are exposed during semantic compaction.

Summary replacement and active-history removal are one SQLite transaction requiring
matching generation, claim token, active chat and prior summary. New activity, clear,
cancellation, shutdown or changed summary invalidates/aborts the attempt; an ignored
provider abort cannot commit stale output. The full archive is never deleted by
compaction. Explicit memory, TODOs, jobs and VFS source files remain unchanged.

Pressure calls share the foreground task's usage, configured/scheduled spend scope
and six-call limit; they reserve one remaining slot for its answer. They never start
or finish a separate foreground run. Idle calls retain their normal bounded task and
chat/day/month accounting. Multi-batch failures leave old summary/history/archive
intact. Neither trigger emits a user message announcing compaction.

On failure/busy/no source or exhausted compaction allowance, foreground history falls
back to whole-message token selection. The system context contains an explicit safe
`Semantic compaction status`, and persisted status remains inspectable. Full sources
stay accessible through chat-scoped `history_search`/`history_read`. Oversized mandatory
context fails safely; no repeated compaction loop or arbitrary phrase clipping occurs.

## Overflow retry, tools and finance

Only explicit structured context-overflow codes or narrow token-window error messages
allow one smaller retry **per task**, persisted across restart. Ordinary HTTP 400/413,
image body-size failures, auth, quota and rate-limit errors do not qualify. Error bodies
are read with a 16 KiB bound and never retained/logged. HTTP, JSON and SSE error events
use the same safe classification.

The retry halves this failed request's estimated input allowance. Foreground history
is rebuilt as whole messages while preserving the current request and live tool
calls/results. Completed tools are not re-executed. Semantic compaction returns deferred
source segments to its queue, retries a smaller batch and consumes every segment before
commit. A request that cannot safely shrink is not resent unchanged. A second overflow
fails. All attempts, including failures/retries, count toward the same six calls and
financial reservation; research preserves its outer synthesis slot.

Context token units and FINANCIAL allowance are separate. The latter remains at least
the baseline conservative request-byte/base64-size reservation, and at least the BPE
estimate. This heuristic is not a statement about image/model tokens. Actual valid
provider usage/cost settles the ledger; missing/ambiguous failures keep the reservation
and `usage_estimated=true`. No cap is relaxed to fund compaction or retries.

A large foreground tool result is stored as COMPLETE JSON in this chat's
`/context/tool-results/` VFS, subject to existing quotas. A bounded pointer replaces
inline content, without a chopped excerpt. Inline admission also considers remaining
mandatory tool-chain budget, not just each result independently. `context_result_read`
provides exact paginated Unicode-safe reads, including long single-line strings.
Tool side effects never repeat because of compaction or overflow recovery.

## Working images and retention

Photos and `describe_image` keep the existing valid PNG/JPEG/WebP, 5 MiB, at-most-two
images, `detail=auto` path with either flag value. No unknown-image shutdown is added.
Without official image counting metadata, image-bearing requests retain the baseline
24-message/12000-character bounded input view, bounded durable views and conservative
financial allowance. The aggregate vision token count remains **unproven**; base64
length is never used to claim a context fit. This compatibility exception is explicit.

Optional verified image bounds (covering EVERY accepted dimension and auto detail)
can later enable aggregate BPE-plus-image admission with the text flag:

```dotenv
LLM_IMAGE_TOKEN_UPPER_BOUND=<verified bound per accepted image>
LLM_IMAGE_TOKEN_METADATA_SOURCE=https://<official evidence>
```

Do not guess a MiniMax/OpenAI image formula for this anonymous alias. Image usage does
not alter the text calibration. Full user/assistant archive persistence and idle
compaction remain enabled in compatibility mode. `/clear` retains its deliberate
history/archive/summary deletion and cancellation behavior; VFS, explicit memory and
saved tasks follow their existing retention policy. Already-discarded legacy text
cannot be reconstructed, but available old archive sources are restored once on upgrade.

## Integration and verification

Integrate the cumulative feature commits from exact `7e0bf94`, preserving the already
separate VFS/native analytics release. Shared agent/budget/store/docs files need careful
merge; no production action is authorized to this worker. The integrator should use
the approved private-database backup procedure before activation. Rollback may disable
the text flag or restore the prior executable without deleting new tables/archive.

Mocked checks (no generation/provider traffic):

```bash
bun test ./checks/*.check.ts checks/analytics src/assistant/core-state.test.ts src/assistant/core-safety.test.ts src/assistant/prompt-jobs.test.ts
bun x tsc --noEmit -p checks/tsconfig-assistant.json
bun x tsc --noEmit -p checks/tsconfig-file-checks.json
bun run build
bun run test
bun run typecheck
```

Final verification: **194 Bun tests pass across 21 files**, including **47 context/compaction tests**; both focused typechecks pass; build passes (467 modules, 5.60 MB). Vitest again reports 704 passing tests / 69 passing suites and the same three baseline failures; global typecheck reports the same TS2493. No provider generation call was made. Checkpoint SHA is in the completion handoff. Context checks cover BPE
boundary/cap/output reserve, full request/tool admission, no text message-count limit,
persisted upward feedback, safe retry/finance/call limits, pressure threshold and actual
semantic replacement, huge tool sources, both trigger orders, failure fallback,
restart/additive migration, clear/cancel/activity races and archive/chat isolation.
Existing media/Whisper/VFS/mini-pages/delivery/research/jobs/analytics checks are included.

Known baseline-wide blockers, previously reproduced at exact `7e0bf94`: Vitest passes
704 tests but cannot import `bun:test` in three existing assistant suites; global
typecheck reports `src/capabilities/browser/job.test.ts:49` TS2493 (empty mock tuple).
Those assistant suites run directly with Bun; active application/checks typechecks
and build are checked separately. Do not call either baseline-wide command passing
unless these unrelated baseline issues are repaired in the integration branch.
