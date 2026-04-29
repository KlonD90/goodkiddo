# Tabular Capability

Provides structured query tools over CSV, TSV, and Excel files in the agent workspace.
The agent supplies structured arguments only — column names, whitelisted operators, whitelisted aggregations, capped limits — and the engine composes the query in memory. No code execution; no free-form SQL from the model.

## Engine Interface

`TabularEngine` (`engine.ts`) defines six methods:

| Method | Purpose |
|--------|---------|
| `describe(data, filename, sheet?)` | Column names, dtypes, row count — no rows loaded |
| `head(data, filename, n, sheet?)` | First N rows (cap 50) |
| `sample(data, filename, n, sheet?, seed?)` | N randomly sampled rows (cap 50, deterministic with seed) |
| `distinct(data, filename, column, limit, sheet?)` | Unique values for a column (cap 200) |
| `filter(data, filename, where, select?, limit, sheet?)` | Rows matching AND-combined conditions (cap 100) |
| `aggregate(data, filename, groupBy?, aggregations, where?, sheet?)` | Grouped/aggregated results (group cap 1000) |

All methods receive the file content as `Uint8Array` plus the filename (for format detection). The workspace path resolution is done at the tool layer, not the engine layer.

## Supported Formats

| Extension | Engine |
|-----------|--------|
| `.csv`, `.tsv`, `.tab` | `StreamingTabularEngine` (csv-parse) |
| `.xlsx`, `.xls`, `.xlsm` | `StreamingTabularEngine` (xlsx package) |
| `.parquet` | Requires a DuckDB-based engine (not yet implemented) |

## Whitelisted Operators (filter `where`)

`eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `in`, `between`, `isnull`

- `in`: `value` must be an array
- `between`: `value` must be `[min, max]`
- `isnull`: `value` is ignored

## Whitelisted Aggregation Functions

`count`, `sum`, `mean`, `min`, `max`, `median`, `stddev`

## Adding a New Engine

1. Implement the `TabularEngine` interface from `engine.ts`.
2. Pass the instance as `tabularEngine` to `createExecutionToolset` in `factory.ts`.
3. All six tool factories will use it automatically.

## NoOpTabularEngine

`NoOpTabularEngine` satisfies the interface but throws `"Tabular engine not configured"` on every call. It is used as the fallback when `enableTabular` is `false` in `AppConfig` (or when no engine is provided).

## Output Budget

Each tool serializes its result to JSON and estimates tokens (`length / 4`). Results exceeding `PER_TOOL_TOKEN_CAP` (4000 tokens) are trimmed row-by-row, and a hint is appended:

```
...truncated — narrow the filter or reduce limit to see more results
```
