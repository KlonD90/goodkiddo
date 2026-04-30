# Feature: Prepared Follow-ups Recall-on-Ambiguity

## Summary

GoodKiddo should handle vague follow-up requests by searching its available internal context before asking the user to repeat themselves. When a user says "continue", "that proposal", "same thing", or "what we discussed", the bot should treat the message as a possible reference to prior GoodKiddo context and run a small deterministic recall pass.

## User cases

- A solo entrepreneur can say "continue with that proposal" after a compaction boundary and GoodKiddo can recover the likely proposal context from tasks, checkpoints, or memory.
- A returning user can say "same thing as before" and receive either the likely match or a focused confirmation question instead of a broad "what do you mean?"
- A user with multiple plausible prior topics can see a short list of likely candidates so they can choose without re-explaining the whole history.

## Scope

In:

- Detect ambiguous continuation phrases.
- Search existing internal context: active tasks, recent forced checkpoint summaries, memory index entries and note snippets, `USER.md`, and `log.md`.
- Accept virtual file candidates only when another safe abstraction has already selected them.
- Rank candidates with high, medium, or low confidence and provide source-backed rationale.
- Tell the assistant how to proceed, confirm, or ask a targeted clarification.

Out:

- Global vector search.
- Expensive full-history scans.
- External integrations.
- Treating a candidate as certain without evidence.

## Design notes

Recall-on-ambiguity extends Prepared Follow-ups by making vague references actionable after time passes, a thread is rotated, or runtime context is compacted. Forced checkpoints are an important source because they preserve compact summaries of current goals, decisions, unfinished work, pending approvals, and artifacts across `/new_thread`, session resume, and prompt-budget boundaries.

The v1 implementation is intentionally deterministic. Recency can support a match, but it is not enough by itself to create high confidence. High-confidence matches require multiple explicit matched terms and a strong score; medium-confidence matches require confirmation; low-confidence results should show 2-3 candidates when available or ask one targeted clarification.
