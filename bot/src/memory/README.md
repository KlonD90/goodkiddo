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
  USER.md            structured user profile
  log.md             append-only events
  notes/<slug>.md    one file per topic
/skills/
  SKILLS.md          index of skills
  <slug>.md          one file per playbook
```

Writes go through the three guarded tools in [`src/tools/memory_tools.ts`](../tools/memory_tools.ts); reads reuse the existing `read_file` / `grep` / `glob` tools.

Memory note topics and skill names must slugify to at least one ASCII letter or number before they are written. This prevents empty paths such as `/memory/notes/.md` or `/skills/.md`. Index hooks are normalized to one line before `MEMORY.md` / `SKILLS.md` are rewritten, so a malformed hook cannot inject extra index entries.

`USER.md` uses a fixed Markdown shape with `## Profile`, `## Preferences`, `## Environment`, `## Constraints`, and `## Open Questions`. New callers are bootstrapped with all five sections. Existing legacy profiles remain readable until `memory_write` with `target: "user"` updates them, at which point the tool normalizes the file into the fixed-section shape. Notes and skills still use `## Actuel` / `## Archive`.

Actionable work is now tracked separately from durable memory. The system prompt injects a compact SQL-backed active-task snapshot on each agent build, and the agent uses the task tools in [`src/tools/task_tools.ts`](../tools/task_tools.ts) for open work that should later be completed or dismissed. Dismissals require an explicit user confirmation turn before `task_dismiss` is allowed to mutate state. This keeps `/memory/` focused on durable facts while the SQL task store tracks in-flight work with explicit `active`, `completed`, and `dismissed` states.

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

Compaction is skipped when the source conversation is empty or below the 20,000-character minimum meaningful-content threshold. Skipped compaction creates no `forced_checkpoints` row and injects no checkpoint appendix; boundary behavior such as `/new_thread` rotation and task reconciliation still proceeds.

Runtime-only current-message metadata is filtered out before compaction and thread summaries are built, so timestamp/timezone guidance stored in checkpoint state does not make an otherwise tiny conversation eligible for restart compaction.

Each checkpoint captures: current goal, decisions, constraints, unfinished work, pending approvals, and important artifacts. Durable user facts such as timezone or scheduling preferences belong in `/memory/USER.md`, not checkpoint payloads. The snapshot is a JSON payload persisted in the `forced_checkpoints` table.

**Checkpoint summary generation** (`checkpoint_compaction.ts`) prompts the model to produce the structured `CheckpointSummary` JSON. The resulting snapshot is serialized and stored in `ForcedCheckpointStore`.

**Runtime context builder** (`runtime_context.ts`) renders a runtime-only prompt appendix from:

1. Latest checkpoint summary (serialized as structured JSON data)
2. Last 2 user-initiated turns (not last 2 messages — turns include all interleaved assistant/tool messages)

That appendix is injected through each rebuilt system prompt until another compaction or explicit non-compacted rotation replaces it, so the persisted thread history still contains just the actual new user/assistant exchanges. The prompt block explicitly labels checkpoint strings as untrusted historical data rather than behavioral instructions. Later compactions summarize the active checkpoint appendix together with the new thread's messages so context is not dropped across repeated rotations.

Writes to prompt-injected memory files (`USER.md`, `MEMORY.md`, and `SKILLS.md`) mark the channel session prompt as dirty. Channel cleanup refreshes the agent after the turn, preserving the thread id and checkpoint state while rebuilding the system prompt from the latest memory snapshot.

When no checkpoint exists yet, the builder falls back to replaying full stored history. `RuntimeContext.hasCompaction` indicates which path was taken.
