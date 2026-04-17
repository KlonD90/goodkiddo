# memory

Per-caller agent memory: long-term notes, procedural skills, append-only log, plus persistent short-term conversation checkpoints. File + grep retrieval, agent-curated.

- `layout.ts` — paths (`/memory/`, `/skills/`), token cap, slug helpers
- `fs.ts` — internal backend helpers (`readOrEmpty`, `overwrite`, `append`, `exists`)
- `bootstrap.ts` — `ensureMemoryBootstrapped` seeds MEMORY.md, SKILLS.md, USER.md, log.md on first use
- `index_manager.ts` — parse/format/upsert entries in the `## Index` section of MEMORY.md / SKILLS.md
- `actuel_archive.ts` — Karpathy-style `## Actuel` / `## Archive` compaction (`applyRotate` moves old content under a dated heading)
- `log.ts` — `appendLog(op, detail)` → `## [YYYY-MM-DD] op | detail`
- `lint.ts` — pure health check over the subtrees (stale, orphan, duplicate, over-budget); findings surface in the system prompt, not as a tool
- `session_loader.ts` — `buildSystemPrompt({ identityPrompt, backend })` composes identity + memory rules + MEMORY/USER/SKILLS snapshot + maintenance block (if any)
- `memory_prompt.md` — identity-agnostic memory-usage rules injected between identity and snapshot
- `summarize.ts` — `summarizeThread(model, messages)` for the `/new-thread` command
- `rotate_thread.ts` — `rotateThread` summarizes the current thread into log.md and rotates `session.threadId`
- `../checkpoints/bun_sqlite_saver.ts` — Bun-native LangGraph checkpointer persisted in `state.db`

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

Conversation state is split into two layers:

- Long-term memory lives in the per-caller `/memory/` and `/skills/` files.
- Short-term thread history lives in LangGraph checkpoints stored by the Bun SQLite saver in [`src/checkpoints/bun_sqlite_saver.ts`](../checkpoints/bun_sqlite_saver.ts) and wired through [`src/channels/shared.ts`](../channels/shared.ts).

Both layers persist across bot restarts. `/new-thread` rotates the active thread id and summarizes the previous thread into `log.md`, but it does not erase long-term memory.
