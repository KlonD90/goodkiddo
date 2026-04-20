# Plan: Forced Checkpoints and Conversation Compaction

## Overview
Add explicit forced checkpoints so stored conversation history can keep growing in the database while model-facing runtime context stays bounded. At defined boundaries, summarize prior conversation into a structured checkpoint, keep a small recent-turn window, and rebuild the active prompt from checkpoint summary, unresolved active items, recent turns, and the current user input.

## Validation Commands
- `bun tsc --noEmit`
- `bun test src/memory/rotate_thread.test.ts src/memory/session_loader.test.ts`
- `bun test src/channels/shared.test.ts src/channels/session_commands.test.ts`
- `bun test src/checkpoints/sql_saver.test.ts`
- `bun test src/memory/checkpoint_compaction.test.ts src/memory/runtime_context.test.ts`

### Task 1: Define checkpoint storage and retrieval
- [x] Add a checkpoint storage module for structured forced-checkpoint records.
- [x] Persist checkpoint summary payloads separately from raw message history.
- [x] Store checkpoint metadata needed for runtime reconstruction, including caller, thread, creation time, and source boundary.
- [x] Add tests for create, read-latest, and caller/thread isolation behavior.

### Task 2: Define structured checkpoint summaries
- [x] Implement a checkpoint summary shape that captures current goal, decisions, constraints, unfinished work, pending approvals, and important artifacts.
- [x] Reuse the existing summarization path where possible, but make the output structured enough for runtime loading.
- [x] Add tests proving summary generation preserves key operational state across compaction.

### Task 3: Build compact runtime context assembly
- [ ] Add a runtime-context builder that assembles prompt input from the latest checkpoint summary, unresolved active items, the last 2 turns, and the current user input.
- [ ] Ensure full stored history is not replayed into runtime context after compaction.
- [ ] Keep raw full history in SQL unchanged for audit and recovery.
- [ ] Add tests that distinguish stored history from model-facing working context.

### Task 4: Add forced compaction triggers
- [ ] Trigger forced checkpoint creation on `/new_thread`.
- [ ] Trigger forced checkpoint creation on the first message after session resume when session lifecycle support exists.
- [ ] Trigger forced checkpoint creation when message or token budget thresholds are exceeded.
- [ ] Leave room for future explicit “conversation ended” detection without making it a v1 dependency.
- [ ] Add tests proving compaction fires only at defined boundaries.

### Task 5: Integrate channels with compacted context loading
- [ ] Update channel/session flow so fresh turns load compacted runtime context rather than all historical messages.
- [ ] Preserve the last 2 turns as the recent-turn window after compaction.
- [ ] Keep `/new_thread` behavior compatible with existing thread rotation while switching runtime loading to checkpoints.
- [ ] Add tests covering long-running conversations, resumed sessions, and post-`/new_thread` turns.

### Task 6: Update docs
- [ ] Keep the high-level feature description in `docs/plan/feature-forced-checkpoints-and-conversation-compaction.md`.
- [ ] Link this execution plan from `docs/plan/README.md`.
- [ ] Update `src/memory/README.md` and `src/channels/README.md` when the feature ships.
- [ ] Update any top-level docs that describe conversation state so they explain `full_history != runtime_context`.
