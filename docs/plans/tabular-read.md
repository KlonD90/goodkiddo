# Plan: Tabular Read

## Overview
Add a fixed, parameterized query API over CSV / XLSX / Parquet files in the workspace. The agent supplies structured arguments only — column names, whitelisted operators, whitelisted aggregations, capped limits — and a native engine composes the underlying query. Results respect `decideAttachmentBudget`; oversized results are trimmed with an actionable hint. No code execution, no free-form SQL from the model. Tools are exposed to the parent agent's default toolset and made available to the research sub-agent later.

## DoD

**Given** a CSV/XLSX/Parquet file in the workspace and a tabular question:

1. **Schema** — `tabular_describe` returns columns + dtypes + row count without loading rows.
2. **Sampling** — `tabular_head`, `tabular_sample`, `tabular_distinct` return bounded rows/values.
3. **Filtering** — `tabular_filter` returns matching rows with `limit ≤ 100`.
4. **Aggregation** — `tabular_aggregate` returns grouped/aggregated results with whitelisted functions.
5. **Safety** — invalid op/agg/sheet/path is rejected by zod before reaching the engine; column/sheet identifiers are quoted; values are parameterized; no concatenated SQL.
6. **Budget** — over-budget results are trimmed; the trim message tells the model how to refine (tighter filter, smaller limit).
7. **Read-tool nudge** — `read_file` description tells the model to prefer `tabular_*` for tabular files over a configurable byte threshold; `decideAttachmentBudget` rejects oversized whole-file reads anyway as a safety net.

## Validation Commands
- `cd bot && bun tsc --noEmit`
- `cd bot && bun test src/capabilities/tabular/*.test.ts`
- `cd bot && bun test src/tools/factory.test.ts`
- `cd bot && bun test src/tools/status_templates.test.ts`

---

### Task 1: Define the tabular engine interface
- [ ] Create `bot/src/capabilities/tabular/engine.ts` exporting a `TabularEngine` interface with: `describe(path, sheet?)`, `head(path, n, sheet?)`, `sample(path, n, sheet?, seed?)`, `distinct(path, column, limit, sheet?)`, `filter(path, where, select?, limit, sheet?)`, `aggregate(path, groupBy?, aggregations, where?, sheet?)`
- [ ] Define result types: `TabularSchema`, `TabularRows`, `TabularGroups` (small, JSON-serializable)
- [ ] Export a `NoOpTabularEngine` that throws `"Tabular engine not configured"` so factory wiring is explicit
- [ ] Add `engine.test.ts` covering: NoOpEngine throws, type contracts compile

### Task 2: Decide and bootstrap engine implementation
- [ ] Pick engine: DuckDB via `@duckdb/node-api` (recommended) **or** streaming-csv fallback on top of existing `csv-parse` from `bot/src/capabilities/spreadsheet/csv_parser.ts`
- [ ] If DuckDB: add dep to `bot/package.json`, document file-format coverage (CSV, XLSX via the duckdb `excel` extension, Parquet)
- [ ] If streaming-csv: support CSV only initially; document that XLSX/Parquet require the DuckDB path
- [ ] Create `bot/src/capabilities/tabular/duckdb_engine.ts` (or `streaming_engine.ts`) implementing `TabularEngine`
- [ ] Identifier safety: column/sheet names must be quoted via the engine's identifier rules; reject names containing the engine's quote character with a clear error
- [ ] Values must be passed as parameter bindings — never string-concatenated
- [ ] Add `*_engine.test.ts` with a small fixture CSV covering: describe, head, sample (deterministic with seed), distinct, filter (each operator), aggregate (each function), groupBy with cap

### Task 3: Define zod schemas and shared validators
- [ ] Create `bot/src/capabilities/tabular/schemas.ts` exporting zod schemas for each tool input
- [ ] Whitelist operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `in`, `between`, `isnull`
- [ ] Whitelist aggregation functions: `count`, `sum`, `mean`, `min`, `max`, `median`, `stddev`
- [ ] Cap limits in zod: `head.n ≤ 50`, `sample.n ≤ 50`, `distinct.limit ≤ 200`, `filter.limit ≤ 100`, group cap ~1000
- [ ] Add `schemas.test.ts` covering: every operator/agg accepted, unknown ones rejected, over-cap limits rejected

### Task 4: Implement tabular tool factories
- [ ] Create `bot/src/capabilities/tabular/tools.ts` exporting six factories: `createTabularDescribeTool`, `createTabularHeadTool`, `createTabularSampleTool`, `createTabularDistinctTool`, `createTabularFilterTool`, `createTabularAggregateTool`
- [ ] Each factory takes `{ engine, workspace }` and returns a LangChain `tool(...)` per the pattern in `bot/src/tools/browser_tools.ts:202`
- [ ] Resolve `path` arguments through `WorkspaceBackend`, never the host filesystem
- [ ] Each tool stringifies the result as compact JSON-ish output and runs it through `estimateAttachmentTokens` from `bot/src/capabilities/attachment_budget.ts`; if over the per-tool cap, truncate and append `"...truncated — narrow the filter or reduce limit"`
- [ ] Add `tools.test.ts` covering: each tool happy path, oversized result truncation, path resolution through workspace, error from engine surfaced as tool error string

### Task 5: Register tools in the execution toolset
- [ ] In `bot/src/tools/factory.ts`, instantiate the engine once per toolset and add the six tools to the `tools` array
- [ ] Pass through `wrapToolWithGuard` so guard semantics match other tools
- [ ] Re-export factories from `bot/src/tools/index.ts`
- [ ] Update `factory.test.ts` to assert the six tools are registered when the engine is enabled

### Task 6: Add status templates
- [ ] In `bot/src/tools/status_templates.ts`, add `ALLOWLISTED_ARGS` entries for each `tabular_*` tool: only `path`, `column`, `fn`, `n` are interpolated (no values, no `where`)
- [ ] Add EN/RU/ES templates for each tool (e.g. `Reading schema of {path}`, `Aggregating {fn}({column}) in {path}`)
- [ ] Add tests in `status_templates.test.ts` covering all three locales

### Task 7: Nudge `read_file` toward `tabular_*` for big tabular files
- [ ] Update the `read_file` tool description in `bot/src/tools/filesystem_tools.ts` to mention "for `.csv`, `.tsv`, `.xlsx`, `.parquet` files prefer `tabular_*` tools"
- [ ] Add a configurable `TABULAR_NUDGE_BYTES` (default 200 KB); when reading a tabular file larger than this, the read-tool prepends a hint to the result asking the model to switch tools
- [ ] `decideAttachmentBudget` already returns `reject` for oversized reads — verify the existing rejection error mentions `tabular_*` for tabular files (small text edit, not a logic change)
- [ ] Add tests covering the nudge fires only for tabular extensions and only over threshold

### Task 8: Config flag and wiring
- [ ] Add `enableTabular: boolean` (default `true`) to `AppConfig` in `bot/src/config.ts`
- [ ] When disabled, factory falls back to `NoOpTabularEngine` and tools are not registered
- [ ] Tests in `config.test.ts` covering on/off

### Task 9: Docs
- [ ] Add `bot/src/capabilities/tabular/README.md` describing engine interface, supported formats, operator/aggregation lists, and how to add a new engine
- [ ] Update `bot/src/channels/README.md` with a brief note pointing at the capability
- [ ] Add a bullet under "Quick Context" in `CLAUDE.md` pointing at the new README
- [ ] Mark the feature checkbox in `docs/plan/feature-tabular-read.md` Related section by linking this plan
