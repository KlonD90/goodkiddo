# Spreadsheet Capability

Parses CSV and Excel files for agent consumption. Files are parsed in memory and discarded.

## Supported Formats

- CSV (`.csv`) — comma/semicolon/tab delimited with quoted fields
- Excel (`.xlsx`, `.xls`) — all sheets are parsed

For Excel sheets, cells with formulas are surfaced as formula strings like `=A2+B2` ahead of cached computed values.

## Files

- `parser.ts` — `SpreadsheetParser` interface and `NoOpSpreadsheetParser`
- `csv_parser.ts` — `CsvParser` implementation using `csv-parse`
- `excel_parser.ts` — `ExcelParser` implementation using `xlsx`
- `renderer.ts` — `renderSpreadsheet()` producing markdown tables
- `constants.ts` — `SPREADSHEET_MAX_BYTES = 10 * 1024 * 1024`
- `fetch.ts` — `fetchTelegramFileBytes` for downloading files

## Parser Interface

```typescript
interface SpreadsheetParseResult {
  sheets: Array<{
    name: string;
    headers: string[];
    rows: string[][];
    rowCount: number;
    colCount: number;
  }>;
  isEmpty: boolean;
  isCorrupt: boolean;
}

interface SpreadsheetParser {
  parse(data: Uint8Array, filename: string, mimeType: string): Promise<SpreadsheetParseResult>;
}
```

## Adding a New Format

1. Create a new parser class implementing `SpreadsheetParser` in `src/capabilities/spreadsheet/`
2. Register it in the parser union used by the Telegram channel (see `src/channels/telegram.ts`)
3. Add tests in `src/capabilities/spreadsheet/`
4. Update this README with the new format details

## Rendering

`renderSpreadsheet(result, filename)` produces:

```
_Spreadsheet: <filename> — N rows, M columns_

| H1 | H2 | ... |
| --- | --- | --- |
| ... | ... | ... |
```

For multi-sheet Excel files, sheets are separated by name headers.

## Configuration

- `ENABLE_SPREADSHEETS=false` disables spreadsheet processing
- files exceeding `SPREADSHEET_MAX_BYTES` (10 MB) are rejected

## Runtime Budget

Spreadsheet parsers should only return extracted sheet content. Attachment-size enforcement is centralized in [`src/capabilities/registry.ts`](../registry.ts) via [`src/capabilities/attachment_budget.ts`](../attachment_budget.ts), so new spreadsheet formats should not reimplement runtime-context budget checks locally.
