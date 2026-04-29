# Feature: Research Sub-Agent

## Summary
Adds a `research` tool that lets the main agent delegate investigation-heavy work — multi-site web research, scanning workspace files for facts — to a short-lived inner LangGraph agent. The parent agent only sees the brief and a compact synthesis; raw page snapshots, file excerpts, and tool-loop noise stay inside the sub-agent. This fixes context bloat, the LangGraph recursion-limit error users hit on deep research turns, and lets us tune model/budget per-task.

## User cases
- A non-technical user asks "compare the top 5 noise-cancelling headphones reviewed this year" and the bot returns a usable comparison without exhausting the conversation context window.
- A user asks "what does the README in this repo say about deployment?" referencing a workspace folder, and the bot reads, summarizes, and answers without dumping the file into chat history.
- A user asks a follow-up question after a research turn and the bot can still answer because the parent's context wasn't consumed by page dumps.

## Scope
**In:**
- New `research` tool callable from the main agent with `{ question, hints?, inputs?, depth? }`.
- Inner `createAgent` per call with isolated `MemorySaver` checkpointer and an explicit `recursionLimit` (`quick`/`standard`/`deep` → 15/40/80).
- Inner toolset: `browser_snapshot`, `browser_action`, `SearxngSearch`, read-only filesystem (`ls`, `read_file` with `offset`/`limit`, `glob`, `grep`), and the `tabular_*` tools from the Tabular Read feature when present.
- Internal `record_finding({ source, summary })` that buffers per-source notes; on completion the buffer is written to `research/<id>.md` in the workspace and the tool returns a compact synthesis (capped via `estimateAttachmentTokens` from `bot/src/capabilities/attachment_budget.ts`).
- Browser sessions namespaced via `createSessionRegistry("research-<id>")` (`bot/src/tools/browser_tools.ts`), sharing the parent's `BrowserSessionManager` so `BROWSER_MAX_CONCURRENT` still applies.
- Status template (`Researching {question}`) added per `bot/src/tools/README.md` rules in EN/RU/ES.
- Config flag `enableBrowserOnParent` (default `false` once `research` ships): browser tools are removed from the parent toolset and live only inside the sub-agent. `SearxngSearch` stays on the parent for cheap one-shot lookups.

**Out:**
- Parallel sub-agents in one turn (single research call per turn for the first iteration).
- Write / send / task / memory / execute tools inside the sub-agent (sub-agent is read-only against the workspace; it never executes arbitrary code, since web pages and untrusted files can influence its prompts).
- Streaming intermediate findings to the user mid-research.
- Cross-session caching of research results.

## Design notes
- The recursion-limit fix is the explicit `.invoke(input, { recursionLimit })` config on the inner agent; there is no `recursionLimit` reference anywhere in the repo today, so this is a net-new control.
- Compact-return contract: the tool's return string is bounded by `decideAttachmentBudget`. If the inner synthesis overshoots, ask the inner model for a shorter version before returning, then fall back to truncation with a pointer to `research/<id>.md`.
- The notes file is the audit trail. Parent can read it lazily with `read_file` only when a follow-up question requires depth.
- `wrapToolWithGuard` wraps the `research` tool the same way other tools are guarded (`bot/src/tools/factory.ts`).
- Sub-agent model can differ from parent (config-gated). Browsing and scanning don't need the parent's strongest model.

## Manual End-to-End Smoke Test

Steps (manual, not automated):

1. Boot the CLI channel (`bot/src/channels/cli.ts`) and ask: "compare three top noise-cancelling headphones reviewed this year"
   - Confirm: single `research` tool call in transcript; `research/<id>.md` written; no `GraphRecursionError`; no `oversized_attachment` checkpoint fired solely from this turn
2. Drop a Financial-Model-sized CSV into the workspace and ask "average revenue in 2024 from financial_model.csv?"; confirm sub-agent uses `tabular_*` tools and never `read_file` on the whole file

## Related
- [Feature: Tabular Read](feature-tabular-read.md) — sub-agent consumes its tools when present.
- Execution plan: `docs/plans/research-subagent.md`.
