# Feature: PDF Documents

## Summary
Users send PDF documents via Telegram and the bot extracts text from them, presenting the content as a readable text block for the agent. This enables the agent to answer questions about document contents without the user retyping.

## User cases
- A user sends a PDF report so that the bot can summarize or answer questions about it.
- A user shares a technical document so that the bot can extract relevant sections.
- A user uploads a contract so that the bot can help review key terms.

## Scope
**In:**
- Telegram `message:document` where `mime_type === "application/pdf"`
- Text extraction from PDF pages
- Files up to 20 MB
- Markdown-formatted text output with page separators

**Out:**
- OCR for scanned PDFs (no extractable text)
- PDF editing or generation
- Password-protected PDF decryption
- Image-only PDFs that require vision models
- Files larger than 20 MB

## Design notes
- PDF text extraction uses a Bun-compatible library (e.g. `pdf-parse`).
- Parsing happens in memory; bytes never touch the virtual filesystem.
- Encrypted PDFs are detected and reported rather than throwing.
- The capability lives in `src/capabilities/pdf/` — channel-agnostic.

## Related
- [Execution plan: PDF Documents](../plans/pdf.md)
