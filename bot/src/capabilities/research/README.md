# Research Capability

Delegates investigation-heavy turns to a short-lived inner LangGraph agent.

## Files

- `notes.ts` — `ResearchNotes` class for accumulating per-source findings and `mintId()` for run IDs
- `prompts.ts` — `RESEARCH_SYSTEM_PROMPT` and `depthToRecursionLimit()` mapping
- `agent.ts` — `buildResearchAgent()` factory that wires the inner agent
- `tool.ts` — `createResearchTool()` outer tool exposed to the parent agent

## Inner Agent Shape

The inner agent runs with:
- Its own `MemorySaver` checkpointer (isolated from parent)
- A `recursionLimit` derived from `depth`: `quick → 15`, `standard → 40`, `deep → 80`
- A `research-<runId>` browser-session namespace that shares the parent's `BrowserSessionManager`

## Toolset (read-only)

- `browser_snapshot`, `browser_action` (scoped namespace)
- `SearxngSearch`
- `ls`, `read_file` (paged via `offset`/`limit`), `glob`, `grep`
- `tabular_*` tools when a tabular engine is provided
- `record_finding` — internal tool to append to `ResearchNotes`

No write/send/task/memory/execute tools are included.

## Recursion Budgets

| depth    | recursionLimit |
|----------|---------------|
| quick    | 15            |
| standard | 40 (default)  |
| deep     | 80            |

## Notes File

After each run, raw notes are written to `research/<runId>.md` in the workspace via `WorkspaceBackend.write`.

## Extending the Inner Toolset Safely

1. Add the new tool to the array assembled in `buildResearchAgent()`.
2. Ensure the tool is read-only; any write surface must be explicitly excluded.
3. Update the unit test in `agent.test.ts` that asserts the toolset contains no write/send/task/memory/execute tools.
