# PDF Capability

Handles PDF document parsing for the Telegram channel. PDFs are parsed in memory and discarded after text extraction.

## Structure

- `extractor.ts` — `PdfExtractor` interface and `NoOpPdfExtractor`
- `pdf_extract_extractor.ts` — `PdfExtractExtractor` implementation using `pdf-parse`
- `constants.ts` — `PDF_MAX_BYTES = 20 * 1024 * 1024` (20 MB cap)
- `content.ts` — `buildPdfContent()` for formatting extracted text
- `fetch.ts` — `fetchTelegramFileBytes()` for downloading files from Telegram

## PdfExtractor Interface

```typescript
export interface PdfPage {
  pageNumber: number;
  text: string;
}

export interface PdfExtractionResult {
  pages: PdfPage[];
isEncrypted: boolean;
isCorrupt: string;
}

export interface PdfExtractor {
  extract(pdfBytes: Uint8Array, filename: string): Promise<PdfExtractionResult>;
}
```

## Adding a New Parser

1. Create a new class implementing `PdfExtractor` in `src/capabilities/pdf/`
2. Export it from the module
3. Wire it in `src/channels/telegram.ts` by instantiating it and passing to the session
4. Add tests covering valid, empty, encrypted, corrupt, and oversized cases

## DoD

When a Telegram user sends a PDF:

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

## Configuration

- `ENABLE_PDF_DOCUMENTS=true|false` — defaults to `true`
