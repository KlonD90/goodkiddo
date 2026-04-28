# Plan: Research Sub-Agent

## Overview
Add a `research` tool that delegates investigation-heavy turns to a short-lived inner LangGraph agent. The inner agent owns its own checkpointer, recursion budget, browser-session namespace, and read-only toolset; it returns a compact synthesis to the parent and writes raw notes to `research/<id>.md` in the workspace. The parent's context is no longer flooded with browser snapshots or large reads, and `GraphRecursionError` is fixed by an explicit `recursionLimit` per call.

## DoD

**Given** a research-style request to the parent agent:

1. **Single tool call** — the parent invokes `research({ question, hints?, inputs?, depth? })` and receives a compact text synthesis under the per-tool token cap.
2. **Notes file** — `research/<id>.md` exists in the workspace and contains the per-source notes captured during the run.
3. **Recursion safe** — the inner agent's `recursionLimit` (15/40/80 for quick/standard/deep) is enforced; recursion-limit errors surface as a polite tool error, not a thrown LangGraph exception.
4. **Browser scoped** — inner browser sessions use a `research-<id>` prefix and share the parent's `BrowserSessionManager` (so `BROWSER_MAX_CONCURRENT` still applies).
5. **Read-only** — inner toolset is web (browse + search) + read-only filesystem + `tabular_*` (when present) + `record_finding`. No write/send/task/memory/execute tools.
6. **Parent stays clean** — `browser_*` removed from parent toolset behind a config flag; `SearxngSearch` may stay on parent for cheap one-shots.
7. **Status feedback** — user sees a `Researching ...` status line during the call.

## Validation Commands
- `cd bot && bun tsc --noEmit`
- `cd bot && bun test src/capabilities/research/*.test.ts`
- `cd bot && bun test src/tools/factory.test.ts`
- `cd bot && bun test src/tools/status_templates.test.ts`

---

### Task 1: Skeleton and IDs
- [ ] Create `bot/src/capabilities/research/` with `agent.ts`, `tool.ts`, `notes.ts`, `prompts.ts`, `README.md`
- [ ] In `notes.ts` define `ResearchNotes` with `add(source, summary)`, `serializeMarkdown()`, and `mintId()` returning `r-<8 random chars>`
- [ ] Add `notes.test.ts` covering: ordering preserved, markdown render shape, id uniqueness

### Task 2: System prompt and depth → recursion table
- [ ] In `prompts.ts` export `RESEARCH_SYSTEM_PROMPT` instructing: investigate the brief, prefer `tabular_*` for tabular files, use paged `read_file` only with `offset`/`limit`, call `record_finding` per useful source, return a terse synthesis when done
- [ ] Export `depthToRecursionLimit(depth)` mapping `quick → 15`, `standard → 40`, `deep → 80`; default `standard`
- [ ] Add `prompts.test.ts` covering the mapping and a snapshot of the prompt string

### Task 3: Inner-agent factory
- [ ] In `agent.ts` export `buildResearchAgent({ model, workspace, browserManager, callerId, runId, tabularEngine? })` that:
  - calls `createSessionRegistry(\`research-\${runId}\`)`
  - assembles the inner toolset: `createBrowserSnapshotTool`, `createBrowserActionTool` (sharing `browserManager`), `SearxngSearch`, `createLsTool`, `createReadFileTool`, `createGlobTool`, `createGrepTool`, plus `tabular_*` tools when the engine is provided, plus an internal `record_finding` tool that writes into a passed `ResearchNotes` instance
  - returns a `createAgent(...)` instance with `MemorySaver` checkpointer and the system prompt from Task 2
- [ ] Inner toolset must NOT include any write/send/task/memory/execute tools — assert via a unit test
- [ ] Add `agent.test.ts` with a stubbed model that drives one `record_finding` call and a final answer; verify notes are recorded and the agent completes

### Task 4: Outer `research` tool
- [ ] In `tool.ts` export `createResearchTool({ model, workspace, browserManager, statusEmitter, locale, tabularEngine? })`
- [ ] Tool args (zod): `{ question: string, hints?: string[], inputs?: string[], depth?: "quick"|"standard"|"deep" }`
- [ ] On invocation:
  - mint `runId`
  - build `ResearchNotes`
  - build inner agent via Task 3
  - invoke with `{ messages: [{ role: "user", content: brief }] }` and config `{ recursionLimit: depthToRecursionLimit(depth), configurable: { thread_id: runId } }`
  - `brief` includes question, hints, and the workspace `inputs` paths
  - on `GraphRecursionError` (catch by name/message), return a polite tool error with the partial notes path
  - after completion, write `research/<runId>.md` via `WorkspaceBackend.write`
  - return a compact summary string; if over cap (per `estimateAttachmentTokens`), ask the inner model for a shorter version once, else truncate with a pointer to the notes file
- [ ] Add `tool.test.ts` covering: happy path returns compact summary, notes file written, recursion limit propagated, oversized output is trimmed with notes-path pointer, recursion error path returns tool-error not throw

### Task 5: Register in execution toolset
- [ ] In `bot/src/tools/factory.ts`, build `createResearchTool` with the parent's `model`, shared `browserManager`, `workspace`, `statusEmitter`, `locale`, and the `tabularEngine` from the Tabular Read feature when available
- [ ] Add a config flag `enableBrowserOnParent` (default `false` once research ships); when `false`, exclude `browser_snapshot` and `browser_action` from the parent toolset (`SearxngSearch` stays on parent)
- [ ] Re-export `createResearchTool` from `bot/src/tools/index.ts`
- [ ] Wrap the `research` tool with `wrapToolWithGuard` like other guarded tools
- [ ] Update `factory.test.ts` asserting: `research` is registered, parent loses `browser_*` when `enableBrowserOnParent` is false

### Task 6: Plumb `model` through factory options
- [ ] Add `model: BaseChatModel` to `CreateExecutionToolsetOptions` in `bot/src/tools/factory.ts`
- [ ] In `bot/src/app.ts`, pass `model` into `createExecutionToolset({...})`
- [ ] Update existing tests/types as required

### Task 7: Status template
- [ ] Add `research` to `ALLOWLISTED_ARGS` in `bot/src/tools/status_templates.ts` allowlisting `question` only (truncated per existing rules)
- [ ] Add EN/RU/ES templates: `Researching {question}` / `Исследую {question}` / `Investigando {question}`
- [ ] Add tests in `status_templates.test.ts`

### Task 8: Config flag
- [ ] Add `enableBrowserOnParent: boolean` (default `false`) to `AppConfig` in `bot/src/config.ts`, persisted in the same shape as other flags
- [ ] Add tests in `config.test.ts` covering on/off

### Task 9: Docs
- [ ] `bot/src/capabilities/research/README.md` describing the inner-agent shape, recursion budgets, notes-file location, and how to extend the inner toolset safely
- [ ] Brief note in `bot/src/channels/README.md` pointing at the new capability
- [ ] Bullet under "Quick Context" in `CLAUDE.md` referencing `bot/src/capabilities/research/README.md`

### Task 10: Manual end-to-end smoke test
- [ ] Boot the CLI channel (`bot/src/channels/cli.ts`) and ask: "compare three top noise-cancelling headphones reviewed this year"
- [ ] Confirm: single `research` tool call in transcript; `research/<id>.md` written; no `GraphRecursionError`; no `oversized_attachment` checkpoint fired solely from this turn
- [ ] Drop a Financial-Model-sized CSV into the workspace and ask "average revenue in 2024 from financial_model.csv?"; confirm sub-agent uses `tabular_*` tools and never `read_file` on the whole file
- [ ] Mark the feature checkbox in `docs/plan/feature-research-subagent.md` Related section by linking this plan
