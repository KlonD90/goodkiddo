# Plan: Prepared Follow-ups — Recall-on-Ambiguity v1

## Goal
When the user says vague continuation phrases like “continue”, “that proposal”, “same thing”, or “what we discussed”, GoodKiddo should search available internal context before asking the user to repeat themselves.

## Product context
GoodKiddo should be accessible for non-technical solo entrepreneurs. If context was compacted or time passed, the assistant should assume the user may be referring to prior GoodKiddo context and do recall work first.

## Existing areas to inspect
- `bot/src/memory/runtime_context.ts`
- `bot/src/memory/checkpoint_compaction.ts`
- `bot/src/memory/session_loader.ts`
- `bot/src/memory/log.ts`
- `bot/src/memory/index_manager.ts`
- `bot/src/memory/user_profile.ts`
- `bot/src/tools/memory_tools.ts`
- `bot/src/tasks/store.ts`
- `bot/src/tasks/reconcile.ts`
- relevant tests under `bot/src/memory/*.test.ts`, `bot/src/tasks/*.test.ts`, `bot/src/tools/*memory*.test.ts`

## Scope
In:
- A small recall module/service that can detect ambiguous continuation references.
- Search active tasks, recent checkpoints, memory notes/index/log entries, and virtual files if already exposed by existing abstractions.
- Return candidate context with confidence.
- Provide prompt/runtime-context wording so the agent can proceed, confirm, or ask targeted clarification.

Out:
- No global vector DB in v1.
- No expensive full-history search.
- No guessing without evidence.
- No external integrations.

## Behavior
Ambiguous reference detection examples:
- “continue”
- “that client”
- “the proposal”
- “as before”
- “same thing”
- “what we discussed”
- “the thing from yesterday”

Expected decision behavior:
- High confidence: proceed with the found context and briefly mention what was found.
- Medium confidence: say the likely match and ask confirmation.
- Low confidence: show 2–3 likely candidates if available, otherwise ask one targeted clarification.

## Validation Commands
- `bun test bot/src/memory/runtime_context.test.ts bot/src/memory/session_loader.test.ts bot/src/tools/memory_tools.test.ts bot/src/tasks/store.test.ts`
- `bun run typecheck`
- `bun run check`

### Task 1: Design a small recall API
- [x] Inspect existing memory/session/task APIs.
- [x] Add a narrowly scoped module for ambiguity detection and recall candidate ranking, or integrate into the most appropriate existing memory/runtime-context module.
- [x] Keep it deterministic/simple for v1; do not add heavy infra.

### Task 2: Candidate sources
- [x] Search active tasks / task titles / source context where available.
- [x] Search recent checkpoint summaries.
- [x] Search memory notes/index/log entries through existing memory abstractions.
- [x] Include virtual files only if an existing safe abstraction already exists; otherwise document as future work. Documented: recall accepts only already-safe virtual file candidates and does not globally scan the virtual filesystem in v1.

### Task 3: Confidence and output shape
- [x] Return candidates with source, summary/snippet, and confidence/rationale.
- [x] Provide a clear high/medium/low threshold policy.
- [x] Ensure no candidate is treated as certain without evidence.

### Task 4: Prompt/runtime integration
- [ ] Update the relevant runtime context or memory prompt so the assistant knows to recall before asking.
- [ ] Include the high/medium/low behavior.
- [ ] Keep Telegram-facing wording concise.

### Task 5: Tests
- [ ] Add tests for ambiguous phrase detection.
- [ ] Add tests for high-confidence single candidate.
- [ ] Add tests for medium/low confidence multiple candidates.
- [ ] Add tests proving the behavior falls back to targeted clarification instead of hallucinating.

### Task 6: Docs
- [ ] Update relevant docs to describe Recall-on-Ambiguity v1.
- [ ] Link it to Prepared Follow-ups / compaction behavior.

## Acceptance Criteria
- GoodKiddo has a tested v1 recall path for ambiguous continuation requests.
- The behavior searches existing internal context before asking the user to repeat.
- It does not require a vector DB or external service.
- It does not invent context when confidence is low.
