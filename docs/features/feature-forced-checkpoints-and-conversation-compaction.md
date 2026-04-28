# Feature: Forced Checkpoints and Conversation Compaction

## Summary
Add explicit forced checkpoints so runtime context stays bounded even when the stored conversation history grows indefinitely. The system should persist full turn history in the database for recovery and audit, but the model-facing working context should be rebuilt from a compact checkpoint summary plus a small recent-turn window. This separates durable storage from active prompt context and prevents old conversations from being replayed in full on every turn.

## User cases
- A user continues a long-running conversation so that the bot stays focused on the current work without dragging the entire past transcript into the model prompt.
- A user resumes work after a pause so that the bot loads a concise operational summary plus the most recent turns instead of all historical messages.
- A user finishes one topic and starts another in the same account so that the old conversation is compacted into a checkpoint rather than polluting the next active exchange.
- An operator needs full historical records for debugging or audit so that raw turn history remains stored even after runtime compaction.

## Scope
**In:**
- Explicit forced checkpoint records for compacted conversation state
- Summary generation at defined boundaries such as `/new_thread`, session resume, or prompt-budget pressure
- Runtime context rebuilt from checkpoint summary plus a small recent-turn window
- Clear separation between stored full history and model-facing compacted context
- Rules for what belongs in checkpoint summaries: user goal, decisions, unfinished work, constraints, pending approvals, and open questions

**Out:**
- Deleting historical messages from storage
- Semantic retrieval over all prior conversation history
- User-facing UI for browsing or editing checkpoints
- Advanced cross-session summarization or clustering
- Replacing durable memory notes, tasks, or user profile storage

## Design notes
- The key invariant is `full_history != runtime_context`. Full history stays in the database; runtime context becomes a compact working set.
- The working prompt should prefer:
  - forced checkpoint summary
  - unresolved active items
  - last 2 turns
  - current user input
- Use last 2 turns, not last 2 messages. Two messages is too brittle for tool-heavy or assistant-heavy exchanges.
- Forced checkpoint creation should happen at explicit boundaries:
  - `/new_thread`
  - first message after session resume
  - message or token budget threshold
  - explicit internal “conversation ended” detection when implemented
- Checkpoint summaries should be structured enough to preserve operational continuity:
  - current goal
  - decisions made
  - constraints and preferences discovered
  - unfinished tasks and pending approvals
  - important artifacts or file paths
- Durable memory remains separate. Long-lived facts still belong in notes, user profile, skills, and tasks; checkpoints are for compressed short-to-medium-term conversation state.
