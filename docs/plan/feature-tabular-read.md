# Feature: Tabular Read

## Summary
Adds a fixed, parameterized query API over tabular workspace files (CSV, XLSX, Parquet). Today the agent has only `read_file` and the spreadsheet renderer at `bot/src/capabilities/spreadsheet/`, which loads sheets fully into context — large files like a financial model exceed the model's context window and cannot be answered at all. The new tools let the agent describe schema, sample rows, filter, and aggregate without ever loading the whole file into the LLM context. The LLM supplies *structured* arguments only; native code composes the underlying query.

## User cases
- A user uploads a multi-megabyte financial model CSV and asks "what's the average revenue in 2024?" — the bot answers with a single number, having read schema and one aggregate, not the whole file.
- A user asks "what columns does this CSV have and how many rows?" — cheap schema + count, no parsing of values.
- A user asks "show me the rows where status = 'failed'" — bounded filter result, capped row count.
- A user asks "group revenue by quarter and sum it" — aggregate result with a small number of groups.

## Scope
**In:**
- New capability `bot/src/capabilities/tabular/` with a query engine (DuckDB-backed via `@duckdb/node-api` recommended; streaming-csv fallback acceptable) that reads CSV/XLSX/Parquet directly off disk via the workspace backend.
- Tools, all with zod-validated structured args:
  - `tabular_describe({ path, sheet? })`
  - `tabular_head({ path, n, sheet? })` (`n ≤ 50`)
  - `tabular_sample({ path, n, sheet?, seed? })` (`n ≤ 50`)
  - `tabular_distinct({ path, column, limit, sheet? })` (`limit ≤ 200`)
  - `tabular_filter({ path, where, select?, limit, sheet? })` (`limit ≤ 100`)
  - `tabular_aggregate({ path, groupBy?, aggregations, where?, sheet? })` (group cap ~1000)
- Whitelisted operators (`eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `in`, `between`, `isnull`) and aggregations (`count`, `sum`, `mean`, `min`, `max`, `median`, `stddev`).
- Identifier safety: column / sheet names quoted by the engine's identifier rules; values always parameterized; user-provided strings never concatenated into a query.
- Result-size enforcement via `estimateAttachmentTokens` / `decideAttachmentBudget` in `bot/src/capabilities/attachment_budget.ts`; over-budget responses are trimmed and surface a clear "use a tighter filter / smaller limit" hint to the model.
- Status templates per `bot/src/tools/README.md` (allowlist `path`, `column`, `fn`, etc.) in EN/RU/ES.
- `wrapToolWithGuard` wrapping like other tools.

**Out:**
- Writing back to spreadsheets (read-only).
- Joins across multiple files.
- Free-form SQL input from the model (explicit non-goal — that is the attack surface we are avoiding).
- Any code execution path; the sub-agent and parent never get `execute_workspace`-style tools to query data.
- Replacing the existing `bot/src/capabilities/spreadsheet/` parser used for sending small spreadsheets back as markdown.

## Design notes
- Engine choice: DuckDB recommended — handles CSV/XLSX/Parquet off disk, handles aggregates fast, gives us identifier-quoting for free. Streaming-CSV fallback works for `head`/`sample`/`filter`/basic aggregates with no new dep but is slower on big files. The decision can be made at implementation time; tools are abstracted over the engine.
- Path safety: `path` arguments are resolved against the `WorkspaceBackend` like every other read tool, not the host filesystem.
- The `tabular_*` tools are useful to the parent agent as well — install them in the default toolset, not only inside the research sub-agent.
- Threshold + system-prompt nudge: when a tabular file exceeds a configurable byte threshold (e.g. 200 KB), the read-tool description tells the model "use `tabular_*` instead of `read_file` for this path". `decideAttachmentBudget` is the safety net that converts an oversized read into a `reject` error the model interprets as the same suggestion.

## Related
- [Feature: Research Sub-Agent](feature-research-subagent.md) — the sub-agent's read-heavy toolset includes these tools.
- Execution plan: TBD `docs/plans/tabular-read.md`.
