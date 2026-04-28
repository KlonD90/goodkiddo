# Feature: Large Attachment Handling

## Summary
When a user sends an attachment (PDF, spreadsheet, voice transcript, or any other capability output), the extracted text is injected into the conversation as a regular message. Today nothing measures that text against the model's context window, so very large documents can either blow the prompt budget silently or push older turns out unpredictably. This feature adds an explicit, configurable context-window budget and two defined outcomes: reject the attachment with a user-visible reply when it cannot fit at all, or proactively compact the conversation before injecting it when it fits only with help.

## User cases
- A user sends a huge PDF so that the bot either tells them it is too large for a single turn or accepts it after compacting older history — never silently truncating.
- A user sends a long spreadsheet dump so that the bot quietly summarizes prior turns into a forced checkpoint to make room, then proceeds with the new content.
- A user continues a long conversation and attaches a medium-sized document so that the bot decides whether compaction is needed based on what already sits in runtime context.
- An operator configures the max context window for their chosen model so that budget decisions track the actual provider limit rather than a hard-coded guess.

## Scope
**In:**
- A configurable max context window size (tokens) for the active model.
- Measuring an attachment's extracted text (the "information unit") against that budget before injecting it into runtime context.
- Rejecting attachments that cannot fit even by themselves, with a user-visible reply.
- Triggering forced compaction when the attachment fits only after compacting prior turns.
- A reserved budget for the forced-checkpoint summary, the previous turn, and the next turn (so compaction is not a tight squeeze).
- Reusing the existing `ForcedCheckpointStore` / `runCompaction` path with a new `oversized_attachment` source boundary.
- Applying uniformly to every capability in `src/capabilities/` (PDF, spreadsheet, voice, future additions) via the shared capability pipeline, not per-channel.

**Out:**
- Splitting a single attachment into multiple turns or chunks.
- Semantic retrieval or RAG over oversized documents.
- Dynamic auto-discovery of model context windows at runtime (the admin sets the budget).
- Summarizing the attachment itself to make it fit.
- Changing per-attachment byte limits (PDF 20 MB, etc.) — those stay.
- Tokenizer-accurate token counts. The rough 1 token ≈ 4 chars heuristic already used in `compaction_trigger.ts` is sufficient.

## Design notes
- The "information unit" measured is the attachment's `CapabilityOutput.currentUserText` (or its content string), not raw bytes. Bytes already have per-capability caps; this budget is about what actually lands in the prompt.
- Budget calculation at decision time:
  - `attachmentTokens` = estimate of extracted text.
  - `available` = `maxContextWindowTokens − reservedForSummary − reservedForRecentTurns − reservedForNextTurn`.
  - If `attachmentTokens > maxContextWindowTokens − reservedForNextTurn`: reject (even an empty conversation could not hold it). The user sees one clear reply.
  - Else if `attachmentTokens + currentRuntimeTokens > available`: trigger forced compaction with `sourceBoundary = "oversized_attachment"`, then inject.
  - Else: inject as today.
- Configuration: add `maxContextWindowTokens` to `AppConfig` with a conservative default (e.g. 150_000) and let it be overridden via `.env`. The existing `DEFAULT_MESSAGE_LIMIT` / `DEFAULT_TOKEN_BUDGET` thresholds stay; this new budget is about *attachment sizing*, not periodic compaction.
- Reserve knobs should be configurable but have sane defaults: `contextReserveSummaryTokens` (~2_000), `contextReserveRecentTurnTokens` (~2_000 for the trailing window), `contextReserveNextTurnTokens` (~2_000 for the model's reply plus the user's next input).
- The capability pipeline is the right seam. `CapabilityRegistry.handle` currently returns a `CapabilityResult`; we add a budget check between `capability.process(...)` and the caller that converts the result into a chat message. Wiring sits in the registry (or a thin wrapper around it) so every channel benefits.
- User-visible messages should be short and actionable, e.g. `"This document is too large for a single turn (≈N tokens, max M). Please send a smaller file or split it."`. Localization can be added later via `src/i18n/`.
- The compaction-before-inject path must be idempotent: if a forced checkpoint was just created for another reason (message/token thresholds), we should not double-compact on the same turn.
- Keep durable memory, notes, and tasks unchanged. This feature lives entirely on the runtime-context side.

## Related
- [Execution plan: Large Attachment Handling](../plans/large-attachment-handling.md)
- [Feature: Forced Checkpoints and Conversation Compaction](feature-forced-checkpoints-and-conversation-compaction.md)
