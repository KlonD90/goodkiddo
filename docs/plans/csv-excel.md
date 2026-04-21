# Plan: CSV and Excel Spreadsheets

## Overview
Handle Telegram `message:document` updates where the document is a CSV or Excel file (.csv, .xlsx, .xls). Download the file, parse the tabular data, and inject it as a readable text representation for the agent. Files are parsed in memory and discarded. Errors surface as user-visible replies.

## DoD

**When** a Telegram user sends a CSV or Excel document to the bot:

1. **Success path (CSV)** — valid CSV, under size limit:
   - Bot downloads the CSV
   - Bot parses and renders as a markdown table
   - Bot injects `"_Spreadsheet: <filename> — N rows, M columns_\n\n<markdown table>"` as content
   - Agent responds to the spreadsheet data as normal user input

2. **Success path (Excel)** — valid .xlsx/.xls, under size limit:
   - Bot downloads the Excel file
   - Bot parses all sheets
   - For each sheet: renders as a markdown table with sheet name header
   - Bot injects combined content with sheet separators
   - Agent responds to the spreadsheet data

3. **Empty file** (no data rows):
   - Bot replies: "This spreadsheet appears to be empty."

4. **Corrupt or invalid file**:
   - Bot replies: "Failed to read spreadsheet: <reason>"

5. **Oversized file** (>10 MB):
   - Bot replies: "Spreadsheet is too large (max 10 MB)."

6. **Unsupported type** (not CSV or Excel):
   - Handler skips — does not reply with error

**The capability is channel-agnostic** — `src/capabilities/spreadsheet/` owns the parser, renderer, constants, and helpers. The Telegram channel wires it for `message:document` where `mime_type` is `text/csv`, `application/vnd.ms-excel`, or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

## Validation Commands
- `bun tsc --noEmit`
- `bun test src/channels/telegram.test.ts`
- `bun test src/capabilities/spreadsheet/*.test.ts` (new test file)

---

### Task 1: Define the spreadsheet parser interface
- [x] Create `src/capabilities/spreadsheet/parser.ts` exporting a `SpreadsheetParser` interface: `parse(data: Uint8Array, filename: string, mimeType: string): Promise<SpreadsheetParseResult>`
- [x] `SpreadsheetParseResult` shape: `{ sheets: Array<{ name: string; headers: string[]; rows: string[][]; rowCount: number; colCount: number }>; isEmpty: boolean; isCorrupt: boolean }`
- [x] Export a `NoOpSpreadsheetParser` that throws `"Spreadsheet parsing not configured"`
- [x] Add `parser.test.ts` covering: `NoOpSpreadsheetParser` throws, interface contract

### Task 2: Implement CSV and Excel parsers
- [x] Create `src/capabilities/spreadsheet/csv_parser.ts` with a `CsvParser` implementing `SpreadsheetParser`
- [x] Use a Bun-compatible CSV parsing library — parse with headers as first row
- [x] Handle quoted fields, different delimiters (detect comma/semicolon/tab)
- [x] Handle encoding issues gracefully
- [x] Create `src/capabilities/spreadsheet/excel_parser.ts` with an `ExcelParser` implementing `SpreadsheetParser`
- [x] Use a Bun-compatible Excel library (e.g. `xlsx`) — read all sheets
- [x] Convert each sheet to `{ name, headers, rows }` — trim whitespace, skip completely empty rows
- [x] On parse failure: set `isCorrupt: true`
- [x] Add `csv_parser.test.ts` and `excel_parser.test.ts` with mocked data covering: valid CSV/excel, empty file, quoted fields, different delimiters, corrupt file

### Task 3: Add spreadsheet capability helpers and constants
- [x] Create `src/capabilities/spreadsheet/constants.ts` with `SPREADSHEET_MAX_BYTES = 10 * 1024 * 1024` (10 MB hard cap)
- [x] Create `src/capabilities/spreadsheet/renderer.ts` with `renderSpreadsheet(result, filename): string` — renders as markdown tables with a header: `"_Spreadsheet: <filename> — <rowCount> rows, <colCount> columns_\n\n<sheet 1 name>\n| H1 | H2 | ... |\n| --- | --- | ... |\n| ... | ... | ... |\n\n<sheet 2 name>..."`
- [x] For single-sheet (CSV): omit sheet name header, just the table
- [x] Create `src/capabilities/spreadsheet/fetch.ts` — reuse `fetchTelegramFileBytes` from the photo handler

### Task 4: Wire parser into telegram channel
- [x] Add `spreadsheetParser?: SpreadsheetParser` field to `ChannelRunOptions` in `src/channels/types.ts`
- [x] In `telegramChannel.run()`, construct a `SpreadsheetParser` (combining CSV + Excel parsers, or a union), pass via `ChannelRunOptions`
- [x] In `ensureTelegramSession`, receive `spreadsheetParser` from options and attach to the session
- [x] Add `spreadsheetParser: SpreadsheetParser` field to `TelegramAgentSession`

### Task 5: Add spreadsheet `message:document` handler in telegram.ts
- [ ] In the existing `bot.on("message:document", ...)` handler, check `mime_type` for CSV or Excel variants
- [ ] If not a supported spreadsheet type: return early (no error reply)
- [ ] On entry: check caller permission, get or create session
- [ ] Check file size — reject with `"Spreadsheet is too large (max 10 MB)."` if exceeds `SPREADSHEET_MAX_BYTES`
- [ ] Download the file via `fetchTelegramFileBytes(file, botToken)`
- [ ] Call `spreadsheetParser.parse(downloaded.data, filename, mimeType)`
- [ ] If `isCorrupt`: reply `"Failed to read spreadsheet: <reason>"` and return
- [ ] If `isEmpty`: reply `"This spreadsheet appears to be empty."` and return
- [ ] Build text content with `renderSpreadsheet(result, filename)`
- [ ] Queue via `handleTelegramQueuedTurn` with the text content

### Task 6: Add config flags
- [ ] Add `enableSpreadsheets: boolean` (default `true`) to `AppConfig` in `src/config.ts`
- [ ] Follow the existing `.env` persistence pattern
- [ ] Add tests covering flag-on and flag-off behavior

### Task 7: Add telegram channel tests for spreadsheets
- [ ] Add `message:document` test cases for CSV and Excel to `src/channels/telegram.test.ts`
- [ ] Cover: valid CSV extraction, valid Excel extraction (single sheet), multi-sheet Excel, empty file, oversized file, corrupt file, unsupported document type ignored
- [ ] Mock the parser and fetchTelegramFileBytes in tests

### Task 8: Docs and cleanup
- [ ] Update `src/channels/README.md` to document spreadsheet support, limits, and configuration
- [ ] Add `src/capabilities/spreadsheet/README.md` describing the parser interface and how to add a new format
- [ ] Add a short note to `CLAUDE.md` pointing at the new docs
