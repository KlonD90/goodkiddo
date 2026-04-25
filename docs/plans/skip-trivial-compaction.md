# Plan: Skip Trivial Compaction

## Overview

Prevent forced checkpoint creation and runtime compaction-context injection when the source conversation is empty or too small to summarize meaningfully. `/new_thread`, session resume, threshold-triggered compaction, and oversized-attachment compaction should all respect the same minimum-content gate while preserving their non-compaction behavior.

## DoD

**Skip behavior:**

1. Empty message history never creates a forced checkpoint.
2. Message history below the minimum normalized character threshold never creates a forced checkpoint.
3. Skipped compaction does not set pending compaction seed or inject checkpoint context.
4. Skipped compaction does not block thread rotation, session resume, task checks, or normal command replies.

**Allowed compaction:**

1. Meaningful history above the threshold still compacts at existing boundaries.
2. Message-limit and token-budget triggers still work once content is meaningful.
3. Oversized-attachment handling still rejects attachments that cannot fit after trivial-context skip.

## Validation Commands

- `bun tsc --noEmit`
- `bun test src/checkpoints/compaction_trigger.test.ts`
- `bun test src/channels/session_commands.test.ts`
- `bun test src/channels/shared.test.ts`
- `bun test src/channels/telegram_attachment_budget.test.ts`

---

### Task 1: Define the minimum-content compaction gate
- [x] Add a small exported helper in `src/checkpoints/compaction_trigger.ts` or a nearby module.
- [x] Normalize message text by trimming whitespace and ignoring empty content.
- [x] Count meaningful characters across the messages that would be summarized.
- [x] Return false for empty history and text below the chosen minimum threshold.
- [x] Return true for text at or above the threshold.
- [x] Add tests for empty arrays, whitespace-only content, short content, exact threshold, and above-threshold content.

### Task 2: Guard direct compaction entry points
- [x] Apply the gate inside or immediately before `runCompaction`.
- [x] Ensure callers can distinguish "skipped" from "failed" without catching an exception.
- [x] Preserve existing failure behavior for real compaction errors.
- [x] Add log output for skipped trivial compaction.
- [x] Update tests for `runCompaction`, `triggerOnSessionResume`, and `triggerOnOversizedAttachment`.

### Task 3: Preserve `/new_thread` behavior while skipping trivial checkpointing
- [x] Update `maybeHandleSessionCommand("/new_thread")` so thread rotation and summary reply still happen when forced checkpointing is skipped.
- [x] Ensure skipped compaction does not set `pendingCompactionSeed`.
- [x] Ensure skipped compaction does not prevent pending task-check behavior.
- [x] Add tests for empty thread, short trivial thread, and meaningful thread.
- [x] Verify existing `/new_thread` tests still pass for compaction-enabled sessions.

### Task 4: Guard auto-compaction and resume paths
- [x] Update threshold preview/check paths so user-facing compaction status is not emitted when the minimum-content gate would skip.
- [x] Ensure message-limit compaction does not fire for many tiny messages below the character threshold.
- [x] Ensure token-budget compaction still fires for meaningful content.
- [x] Update session-resume compaction so a trivial skip clears the resume-compaction flag.
- [x] Filter runtime-only current-message metadata before restart/resume compaction decisions.
- [x] Add tests for threshold skip, threshold allow, resume skip, and resume allow.

### Task 5: Guard oversized-attachment compaction
- [x] Update oversized-attachment compaction so it skips checkpoint work when prior context is empty or trivial.
- [x] Ensure attachment budget logic re-evaluates correctly after a skip.
- [x] If the attachment still cannot fit, preserve the existing too-large rejection path.
- [x] Add attachment-budget tests for empty-context oversized attachment, trivial-context oversized attachment, and meaningful-context compaction.

### Task 6: Update docs and final validation
- [x] Update `src/channels/README.md` conversation-compaction section with the skip rule.
- [x] Update `src/memory/README.md` if it describes compaction boundaries without mentioning the minimum-content gate.
- [x] Link this plan from `docs/plan/README.md`.
- [ ] Run all validation commands listed above.
- [ ] Mark tasks complete only after implementation and tests pass.
