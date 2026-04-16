# memory

Per-caller agent memory: long-term notes, procedural skills, append-only log. File + grep retrieval, agent-curated.

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

Writes go through the three guarded tools in [`src/tools/memory_tools.ts`](../tools/memory_tools.ts); reads reuse the existing `read_file` / `grep` / `glob` tools. Short-term conversation history lives in a LangGraph `MemorySaver` wired in [`src/app.ts`](../app.ts).
