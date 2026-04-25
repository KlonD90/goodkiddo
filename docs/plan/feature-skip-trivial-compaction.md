# Feature: Skip Trivial Compaction

## Summary

Avoid creating forced checkpoints or injecting compaction context when the source conversation is empty or too small to summarize meaningfully. Compaction should remain a tool for preserving substantial operational context, not a routine step that creates empty summaries after a fresh chat, a tiny exchange, or a short `/new_thread` boundary.

## User Cases

- A user starts a new chat and immediately runs `/new_thread`; the bot rotates cleanly without creating an empty checkpoint.
- A user has only exchanged a few short messages; the bot should not spend model work summarizing content that is too small to matter.
- A user resumes an almost-empty thread; the bot should continue normally without injecting a useless "compacted context" block.
- An operator inspecting checkpoints should see only meaningful summaries, not records generated from empty or trivial chats.

## Scope

**In:**

- A minimum-content gate before forced checkpoint creation.
- Skip compaction for empty message lists.
- Skip compaction when the combined meaningful text is below a small character threshold.
- Apply the gate consistently to `/new_thread`, session resume, automatic threshold compaction, and oversized-attachment compaction.
- Preserve normal thread rotation and command replies even when compaction is skipped.
- Avoid setting pending compaction seed/context when no checkpoint was created.

**Out:**

- Changing the main high-water thresholds for message count or token budget.
- Deleting old checkpoint records.
- Semantic analysis to decide whether content is "important enough."
- User-facing controls for the minimum threshold.
- Changing long-term memory, active tasks, or stored full-history behavior.

## Design Notes

### Meaningful Content Gate

The gate should answer a simple question before compaction starts: "Is there enough prior conversation text to justify a summary?"

Suggested first version:

- no messages: skip
- only whitespace or non-text content with no extracted text: skip
- total normalized text below the default minimum of 20,000 characters: skip
- otherwise allow the existing compaction boundary logic to proceed

The threshold should be intentionally conservative. It is not a quota feature; it only prevents obviously useless checkpoint work.

### Boundary Behavior

`/new_thread` should still rotate the active thread and produce the normal user-facing reply. The only difference is that a trivial previous thread does not create a forced checkpoint and does not seed the next thread with empty compaction context.

Session-resume compaction should similarly do nothing for empty or tiny stored history. Resume should not mark the session as needing compaction forever after a deliberate skip.

Threshold-based compaction should keep using message/token limits, but the final compaction call should still be guarded by the minimum-content check. This prevents artificial tests or many tiny messages from creating a low-value summary.

Oversized-attachment compaction should not run if there is no meaningful prior context to compact. If the attachment cannot fit even without useful prior context, the existing attachment rejection path should handle it.

### Context Injection

Skipping compaction means no forced-checkpoint record exists for that boundary. The runtime should therefore not inject a checkpoint appendix, pending compaction seed, or "compacted context" block for that skipped boundary.

This matters because an empty checkpoint can confuse the prompt: it implies there is prior operational state when there is none.

### Observability

Logs should distinguish "compaction skipped because content is trivial" from "threshold not reached" and "compaction failed." This makes it easier to debug why no checkpoint appeared after `/new_thread`.

## Validation Expectations

Implementation tasks belong in `docs/plans/`, but this feature should eventually be validated against these observable outcomes:

- `/new_thread` on an empty thread rotates without creating a forced checkpoint.
- `/new_thread` on a short trivial thread rotates without setting pending compaction seed.
- `/new_thread` on a meaningful thread still creates a checkpoint.
- Session resume with empty or tiny history does not create or inject compaction context.
- Threshold compaction does not run when content is below the minimum character threshold.
- Oversized-attachment compaction is skipped when there is no meaningful prior context to compact.

## Risks and Open Questions

- **Threshold tuning:** Too low a threshold still creates noisy summaries; too high a threshold may skip useful short conversations. Start with a conservative constant and adjust from real usage.
- **Non-text content:** Attachments may produce structured or multimodal content. The gate should use the same text extraction path used for token estimation where possible.
- **Task reconciliation:** Skipping compaction should not skip task reconciliation or `/new_thread` task surfacing. Those are separate boundary behaviors.
