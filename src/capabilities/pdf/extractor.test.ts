import { describe, expect, test } from "bun:test";
import {
	NoOpPdfExtractor,
	type PdfExtractor,
	type PdfExtractionResult,
} from "./extractor";

class StubPdfExtractor implements PdfExtractor {
	async extract(pdfBytes: Uint8Array, filename: string): Promise<PdfExtractionResult> {
		return {
			pages: [{ pageNumber: 1, text: `${filename}:${pdfBytes.length}` }],
			isEncrypted: false,
			isCorrupt: false,
		};
	}
}

describe("pdf extractor", () => {
	test("NoOpPdfExtractor throws when PDF extraction is not configured", async () => {
		const extractor = new NoOpPdfExtractor();

		expect(
			extractor.extract(new Uint8Array([1, 2, 3]), "test.pdf"),
		).rejects.toThrow(/PDF extraction not configured/i);
	});

	test("accepts implementations that satisfy the extractor contract", async () => {
		const extractor: PdfExtractor = new StubPdfExtractor();

		await expect(
			extractor.extract(new Uint8Array([1, 2, 3]), "test.pdf"),
		).resolves.toEqual({
			pages: [{ pageNumber: 1, text: "test.pdf:3" }],
			isEncrypted: false,
			isCorrupt: false,
		});
	});
});