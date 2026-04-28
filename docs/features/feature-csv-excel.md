# Feature: CSV and Excel Spreadsheets

## Summary
Users send CSV or Excel files via Telegram and the bot parses the tabular data, presenting it as readable markdown tables for the agent. This enables the agent to analyze, summarize, or answer questions about spreadsheet data.

## User cases
- A user sends a CSV export from a tool so that the bot can analyze the data.
- A user shares an Excel workbook with multiple sheets so that the bot can compare across sheets.
- A data analyst uploads a spreadsheet so that the bot can generate insights or pivot summaries.

## Scope
**In:**
- Telegram `message:document` with `mime_type` for CSV or Excel (.csv, .xlsx, .xls)
- Text extraction rendered as markdown tables
- Multi-sheet Excel support with sheet name headers
- Files up to 10 MB
- Auto-detection of delimiter for CSV (comma, semicolon, tab)

**Out:**
- Editing or writing back to spreadsheets
- Formula evaluation or recalculation
- Chart or image extraction from Excel
- Files larger than 10 MB
- Password-protected Excel files

## Design notes
- CSV parsing uses a Bun-compatible library; Excel uses `xlsx` or similar.
- Parsing happens in memory; bytes never touch the virtual filesystem.
- Each sheet renders as a markdown table with sheet name as a header.
- The capability lives in `src/capabilities/spreadsheet/` — channel-agnostic.

## Related
- [Execution plan: CSV and Excel Spreadsheets](../plans/csv-excel.md)
