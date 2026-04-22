# Plan: Large Attachment Handling

## Overview
Gate every attachment against a configurable max context window. Measure the extracted text ("information unit"), compare against budget minus reserves for the checkpoint summary, the recent-turn window, and the next turn. If the attachment cannot fit at all, reply with a clear "too large" message. If it fits only with compaction, fire a forced checkpoint with a new `oversized_attachment` boundary before injecting it. The capability pipeline is the single enforcement seam so PDF, spreadsheet, voice, and future capabilities share the behavior.

## DoD

**When** a capability produces a `CapabilityOutput`:

1. **Fits comfortably** — attachment tokens + current runtime tokens ≤ available budget:
   - Capability output is injected as today.
   - No compaction fires.

2. **Fits only with compaction** — attachment tokens ≤ `maxContextWindowTokens − reservedForNextTurn` but `attachmentTokens + currentRuntimeTokens > available`:
   - A forced checkpoint is created with `sourceBoundary = "oversized_attachment"`.
   - Runtime context is rebuilt from the new checkpoint + recent window.
   - Capability output is then injected.
   - User sees a short notice that older context was summarized to make room (optional, behind a flag).

3. **Cannot fit at all** — attachment tokens > `maxContextWindowTokens − reservedForNextTurn`:
   - Capability output is NOT injected.
   - User sees: `"This <type> is too large for a single turn (≈<N> tokens, max <M>). Please send a smaller file or split it."`
   - No compaction fires.

4. **Idempotency** — if a forced checkpoint was already created earlier in the same turn for another reason, `oversized_attachment` compaction is skipped; the budget check is re-evaluated against the fresh runtime context.

5. **Config** — `maxContextWindowTokens`, `contextReserveSummaryTokens`, `contextReserveRecentTurnTokens`, `contextReserveNextTurnTokens` are all readable from `.env` and have sane defaults.

## Validation Commands
- `bun tsc --noEmit`
- `bun test src/capabilities/registry.test.ts`
- `bun test src/capabilities/attachment_budget.test.ts`
- `bun test src/checkpoints/compaction_trigger.test.ts`
- `bun test src/channels/telegram.test.ts src/channels/cli.test.ts`

---

### Task 1: Add context-window config
- [x] Add `maxContextWindowTokens: number`, `contextReserveSummaryTokens: number`, `contextReserveRecentTurnTokens: number`, `contextReserveNextTurnTokens: number` to `AppConfig` in `src/config.ts`.
- [x] Follow the existing `.env` persistence pattern: add `MAX_CONTEXT_WINDOW_TOKENS`, `CONTEXT_RESERVE_SUMMARY_TOKENS`, `CONTEXT_RESERVE_RECENT_TURN_TOKENS`, `CONTEXT_RESERVE_NEXT_TURN_TOKENS` to `PERSISTED_ENV_KEYS`, the `ConfigIssueField` union, both regex allow-lists, `formatPersistedEnvLine`, and `readConfigFromEnv`.
- [x] Defaults: `MAX_CONTEXT_WINDOW_TOKENS=150000`, summary=2000, recent=2000, next=2000.
- [x] Validate values are positive integers in `findConfigIssues`; fall back to defaults when missing, reject negatives/NaN with a clear reason.
- [x] Add tests in `src/config.test.ts` (or nearest existing config test) covering default, override via env, invalid values.

### Task 2: Define attachment budget primitives
- [x] Create `src/capabilities/attachment_budget.ts` exporting:
  - `estimateAttachmentTokens(output: CapabilityOutput): number` using the same `Math.ceil(length / 4)` heuristic used in `src/checkpoints/compaction_trigger.ts:49`. If `content` is an array, sum text parts only; ignore image bytes.
  - `AttachmentBudgetDecision = { kind: "fit" } | { kind: "compact_then_inject"; attachmentTokens: number } | { kind: "reject"; attachmentTokens: number; maxTokens: number }`.
  - `decideAttachmentBudget(params: { attachmentTokens: number; currentRuntimeTokens: number; config: AttachmentBudgetConfig }): AttachmentBudgetDecision` implementing the rules from the feature DoD.
  - `AttachmentBudgetConfig = { maxContextWindowTokens: number; reserveSummaryTokens: number; reserveRecentTurnTokens: number; reserveNextTurnTokens: number }`.
- [x] Create `src/capabilities/attachment_budget.test.ts` covering: comfortably-fits, fits-only-with-compaction, cannot-fit (just over reject threshold), exact boundary cases, zero runtime tokens.

### Task 3: Add `oversized_attachment` compaction boundary
- [ ] Extend `SourceBoundary` in `src/checkpoints/forced_checkpoint_store.ts` to include `"oversized_attachment"`.
- [ ] Add a helper in `src/checkpoints/compaction_trigger.ts`:
  `triggerOnOversizedAttachment(context: CompactionContext): Promise<ForcedCheckpoint>` that calls `runCompaction(context, "oversized_attachment")`.
- [ ] Extend `src/checkpoints/compaction_trigger.test.ts` with a test that the new helper fires `runCompaction` with the correct boundary.
- [ ] Verify `src/memory/runtime_context.ts` treats the new boundary identically to existing boundaries (no special-casing needed); add a regression test in `src/memory/runtime_context.test.ts`.

### Task 4: Wire budget check into the capability pipeline
- [ ] Extend `CapabilityRegistry.handle` in `src/capabilities/registry.ts` to accept an optional `budget?: { config: AttachmentBudgetConfig; currentRuntimeTokens: number; compact: () => Promise<void> }` argument. When `budget` is undefined, behavior is unchanged.
- [ ] After `processWith` succeeds, call `estimateAttachmentTokens` on the `CapabilityOutput`, then `decideAttachmentBudget`.
  - On `"reject"`: return `{ ok: false, userMessage: formatTooLargeMessage(capability.name, decision) }` without invoking the original result.
  - On `"compact_then_inject"`: `await budget.compact()`, then return the original success result.
  - On `"fit"`: return the original success result.
- [ ] Add `formatTooLargeMessage(capabilityName, decision)` producing `"This <type> is too large for a single turn (≈<N> tokens, max <M>). Please send a smaller file or split it."`. Keep capability-name → user-facing-type mapping small and local (e.g. `pdf → "PDF"`, `spreadsheet → "spreadsheet"`, `voice → "voice message"`, fallback to capability name).
- [ ] Add tests in `src/capabilities/registry.test.ts` covering: no-budget passthrough, reject path, compact-then-inject path (mock `compact`), fit path, and that `compact` is not called on reject.

### Task 5: Supply runtime-token and compaction plumbing from channels
- [ ] Identify the channel/session code that currently calls `CapabilityRegistry.handle` for each entrypoint (Telegram: `src/channels/telegram.ts`; CLI: `src/channels/cli.ts`; any shared helper in `src/channels/shared.ts`).
- [ ] At each call site, build the `budget` parameter:
  - `config` from `AppConfig` (map the four new fields).
  - `currentRuntimeTokens` by calling `estimateTokens` from `src/checkpoints/compaction_trigger.ts` against the current runtime-context messages. Reuse the same accessor used to assemble prompts in `src/memory/runtime_context.ts`.
  - `compact` closure that calls `triggerOnOversizedAttachment` with the already-available `CompactionContext` (caller, threadId, messages, model, store) and then refreshes the local messages/runtime view so the subsequent injection sees the compacted state.
- [ ] Guard against double compaction: if a forced checkpoint was created earlier in the same turn (message_limit/token_limit path), skip the `oversized_attachment` trigger but re-run the budget decision against the fresh state; if it now fits, proceed; if it still does not, reject.
- [ ] Update channel tests in `src/channels/telegram.test.ts` and `src/channels/cli.test.ts` to cover: oversized attachment rejection, mid-range attachment triggering compaction, small attachment unchanged.

### Task 6: Optional user notice when compaction fires for attachment
- [ ] Add a short, non-blocking status reply (e.g. `"Summarizing older messages to make room for this document…"`) emitted before injection when `kind === "compact_then_inject"`. Route through the existing status/ephemerality path in `src/channels/` (see `src/channels/README.md` and `src/tools/status_ephemerality.test.ts` for conventions).
- [ ] Gate it behind a config flag `enableAttachmentCompactionNotice: boolean` (default `true`) in `AppConfig` with env var `ENABLE_ATTACHMENT_COMPACTION_NOTICE` following the same `.env` persistence pattern as other boolean flags.
- [ ] Add tests covering flag-on (notice sent) and flag-off (no notice) behavior.

### Task 7: Docs and discoverability
- [ ] Add a "Large attachment handling" section to `src/channels/README.md` explaining the three outcomes, the four new config knobs, and the default values.
- [ ] Add a note to `src/capabilities/pdf/README.md`, `src/capabilities/spreadsheet/README.md`, and `src/capabilities/voice/README.md` pointing to the shared budget enforcement in `src/capabilities/registry.ts` (so capability authors do not reimplement it).
- [ ] Update `CLAUDE.md` Quick Context to mention `src/capabilities/attachment_budget.ts` as the shared budget seam.
- [ ] Move the completed `feature-forced-checkpoints-and-conversation-compaction.md` row in `docs/plan/README.md` to show the new feature under "Active plans"; link this execution plan from the feature doc.
