# memory

Per-caller agent memory: long-term notes, procedural skills, append-only log, plus persistent short-term conversation checkpoints. File + grep retrieval, agent-curated.

- `layout.ts` — paths (`/memory/`, `/skills/`), token cap, slug helpers
- `fs.ts` — internal backend helpers (`readOrEmpty`, `overwrite`, `append`, `exists`)
- `bootstrap.ts` — `ensureMemoryBootstrapped` seeds MEMORY.md, SKILLS.md, USER.md, log.md on first use
- `index_manager.ts` — parse/format/upsert entries in the `## Index` section of MEMORY.md / SKILLS.md
- `actuel_archive.ts` — Karpathy-style `## Actuel` / `## Archive` compaction (`applyRotate` moves old content under a dated heading)
- `log.ts` — `appendLog(op, detail)` → `## [YYYY-MM-DD] op | detail`
- `lint.ts` — pure health check over the subtrees (stale, orphan, duplicate, over-budget); findings surface in the system prompt, not as a tool
- `session_loader.ts` — `buildSystemPrompt({ identityPrompt, backend, activeTaskSnapshot? })` composes identity + memory rules + MEMORY/USER/SKILLS snapshot + active-task snapshot + maintenance block (if any)
- `memory_prompt.md` — identity-agnostic memory-usage rules injected between identity and snapshot
- `summarize.ts` — `summarizeThread(model, messages)` for the `/new_thread` command
- `rotate_thread.ts` — `rotateThread` summarizes the current thread into log.md and rotates `session.threadId`
- `../checkpoints/sql_saver.ts` — SQL-backed LangGraph checkpointer persisted via the shared `DATABASE_URL` connection

Layout per caller:

```
/memory/
  MEMORY.md          index of notes
  USER.md            user profile
  log.md             append-only events
  notes/<slug>.md    one file per topic
/skills/
  SKILLS.md          index of skills
  <slug>.md          one file per playbook
```

Writes go through the three guarded tools in [`src/tools/memory_tools.ts`](../tools/memory_tools.ts); reads reuse the existing `read_file` / `grep` / `glob` tools.

Actionable work is now tracked separately from durable memory. The system prompt injects a compact SQL-backed active-task snapshot on each agent build, and the agent uses the task tools in [`src/tools/task_tools.ts`](../tools/task_tools.ts) for open work that should later be completed or dismissed. This keeps `/memory/` focused on durable facts while the SQL task store tracks in-flight work with explicit `active`, `completed`, and `dismissed` states.

Conversation state is split into two layers:

- Long-term memory lives in the per-caller `/memory/` and `/skills/` files.
- Short-term thread history lives in LangGraph checkpoints stored by the SQL saver in [`src/checkpoints/sql_saver.ts`](../checkpoints/sql_saver.ts) and wired through [`src/channels/shared.ts`](../channels/shared.ts).

Both layers persist across bot restarts. `/new_thread` rotates the active thread id and summarizes the previous thread into `log.md`, but it does not erase long-term memory. The follow-up boundary check then uses the active-task store, not the memory wiki, to reconcile obvious completions or prompt for dismissals.

## Conversation compaction

`full_history != runtime_context`. Full turn history is stored in the SQL saver permanently for audit and recovery. The model-facing working context is rebuilt from a compact checkpoint plus a small recent-turn window — it does not replay the entire stored history on each turn.

Key invariant: stored history grows indefinitely; model context stays bounded.

**Forced checkpoints** (`src/checkpoints/forced_checkpoint_store.ts`) store a structured snapshot of operational state at defined compaction boundaries:

- `/new_thread` command
- first message after session resume
- message or token budget threshold exceeded

Each checkpoint captures: current goal, decisions, constraints, unfinished work, pending approvals, and important artifacts. The snapshot is a JSON payload persisted in the `forced_checkpoints` table.

**Checkpoint summary generation** (`checkpoint_compaction.ts`) prompts the model to produce the structured `CheckpointSummary` JSON. The resulting snapshot is serialized and stored in `ForcedCheckpointStore`.

**Runtime context builder** (`runtime_context.ts`) renders a runtime-only prompt appendix from:

1. Latest checkpoint summary (serialized as structured JSON data)
2. Last 2 user-initiated turns (not last 2 messages — turns include all interleaved assistant/tool messages)

That appendix is injected through the rebuilt system prompt for the next turn only, so the persisted thread history still contains just the actual new user/assistant exchange. The prompt block explicitly labels checkpoint strings as untrusted historical data rather than behavioral instructions.

When no checkpoint exists yet, the builder falls back to replaying full stored history. `RuntimeContext.hasCompaction` indicates which path was taken.
