# Plan: PDF Documents

## Overview
Handle Telegram `message:document` updates where the document is a PDF. Download the file, extract its text content, and inject it as a text block for the agent. PDFs are parsed in memory and discarded. Errors surface as user-visible replies.

## DoD

**When** a Telegram user sends a PDF document to the bot:

1. **Success path** — valid PDF, under size limit:
   - Bot downloads the PDF
   - Bot extracts text from each page
   - Bot injects the text as `_Document: <filename>_` prefixed content
   - Agent responds to the document content as normal user input

2. **Empty PDF** (no extractable text):
   - Bot replies: "This PDF appears to contain no text."

3. **Encrypted/password-protected PDF**:
   - Bot replies: "This PDF is password-protected and cannot be read."

4. **Corrupt or invalid PDF**:
   - Bot replies: "Failed to read PDF: <reason>"

5. **Oversized PDF** (>20 MB):
   - Bot replies: "PDF is too large (max 20 MB)."

6. **Unsupported type** (not a PDF):
   - Handler skips — does not reply with error

**The capability is channel-agnostic** — `src/capabilities/pdf/` owns the parser, extractor, constants, and helpers. The Telegram channel wires it for `message:document` where `mime_type === "application/pdf"`.

## Validation Commands
- `bun tsc --noEmit`
- `bun test src/channels/telegram.test.ts`
- `bun test src/capabilities/pdf/*.test.ts` (new test file)

---

### Task 1: Define the PDF extractor interface
- [x] Create `src/capabilities/pdf/extractor.ts` exporting a `PdfExtractor` interface: `extract(pdfBytes: Uint8Array, filename: string): Promise<PdfExtractionResult>`
- [x] `PdfExtractionResult` shape: `{ pages: Array<{ pageNumber: number; text: string }>; isEncrypted: boolean; isCorrupt: boolean }`
- [x] Export a `NoOpPdfExtractor` that throws `"PDF extraction not configured"` — used when no extractor is wired
- [x] Add `extractor.test.ts` covering: `NoOpPdfExtractor` throws, interface contract

### Task 2: Implement PDF text extraction
- [x] Create `src/capabilities/pdf/pdf_extract_extractor.ts` with a `PdfExtractExtractor` class implementing `PdfExtractor`
- [x] Use a Bun-compatible PDF parsing library (e.g. `pdf-parse` or similar) — verify it works with Bun's fetch/buffer semantics
- [x] `extract` reads all pages sequentially, returns text per page
- [x] Detect encrypted PDFs and set `isEncrypted: true` without throwing
- [x] On parse failure, set `isCorrupt: true` and include the error message
- [x] Add `pdf_extract_extractor.test.ts` with mocked PDF bytes covering: valid PDF, empty PDF, encrypted PDF, corrupt PDF, oversized file

### Task 3: Add PDF capability helpers and constants
- [x] Create `src/capabilities/pdf/constants.ts` with `PDF_MAX_BYTES = 20 * 1024 * 1024` (20 MB hard cap)
- [x] Create `src/capabilities/pdf/content.ts` with `buildPdfContent(pages, filename): string` — returns italic-prefixed summary: `"_Document: <filename> — N pages_\n\n<page 1 text>\n\n--- Page 2 ---\n<page 2 text>..."`
- [x] Create `src/capabilities/pdf/fetch.ts` — reuse `fetchTelegramFileBytes` from the photo handler (same download URL pattern, documents use the same API)

### Task 4: Wire PDF extractor into telegram channel
- [x] Add `pdfExtractor?: PdfExtractor` field to `ChannelRunOptions` in `src/channels/types.ts`
- [x] In `telegramChannel.run()`, construct a `PdfExtractExtractor`, pass via `ChannelRunOptions`
- [x] In `ensureTelegramSession`, receive `pdfExtractor` from options and attach to the session
- [x] Add `pdfExtractor: PdfExtractor` field to `TelegramAgentSession`

### Task 5: Add PDF `message:document` handler in telegram.ts
- [x] Add `bot.on("message:document", ...)` handler that checks `ctx.message.document.mime_type === "application/pdf"`
- [x] If not a PDF: return early (no error reply — other document types are out of scope)
- [x] On entry: check caller permission, get or create session
- [x] Check audio file size (`file_size` field) — reject with `"PDF is too large (max 20 MB)."` if exceeds `PDF_MAX_BYTES`
- [x] Download the file via `fetchTelegramFileBytes(file, botToken)`
- [x] Call `pdfExtractor.extract(downloaded.data, filename)`
- [x] If `isEncrypted`: reply `"This PDF is password-protected and cannot be read."` and return
- [x] If `isCorrupt`: reply `"Failed to read PDF: <reason>"` and return
- [x] If all pages have empty text: reply `"This PDF appears to contain no text."` and return
- [x] Build text content with `buildPdfContent(result.pages, filename)`
- [x] Queue via `handleTelegramQueuedTurn` with the text content

### Task 6: Add config flags
- [x] Add `enablePdfDocuments: boolean` (default `true`) to `AppConfig` in `src/config.ts`
- [x] Follow the existing `.env` persistence pattern
- [x] Add tests covering flag-on and flag-off behavior

### Task 7: Add telegram channel tests for PDF
- [x] Add `message:document` test cases to `src/channels/telegram.test.ts`
- [x] Cover: valid PDF extraction, encrypted PDF rejection, corrupt PDF rejection, empty PDF reply, oversized PDF rejection, non-PDF document ignored
- [x] Mock the extractor and fetchTelegramFileBytes in tests

### Task 8: Docs and cleanup
- [x] Update `src/channels/README.md` to document PDF support, limits, and configuration
- [x] Add `src/capabilities/pdf/README.md` describing the extractor interface and how to add a new parser
- [x] Add a short note to `CLAUDE.md` pointing at the new docs
