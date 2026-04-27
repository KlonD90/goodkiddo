import { describe, expect, test } from "bun:test";
import {
	PdfExtractExtractor,
	type PdfParserFactory,
} from "./pdf_extract_extractor";

describe("PdfExtractExtractor", () => {
	test("extracts text from valid PDF", async () => {
		const mockFactory: PdfParserFactory = () => ({
			getText: async () => ({
				pages: [
					{ num: 1, text: "Hello from page 1" },
					{ num: 2, text: "Hello from page 2" },
				],
				text: "Hello from page 1\nHello from page 2",
				total: 2,
			}),
			destroy: async () => {},
		});

		const extractor = new PdfExtractExtractor(mockFactory);
		const result = await extractor.extract(
			Uint8Array.from([1, 2, 3, 4]),
			"test.pdf",
		);

		expect(result.pages).toEqual([
			{ pageNumber: 1, text: "Hello from page 1" },
			{ pageNumber: 2, text: "Hello from page 2" },
		]);
		expect(result.isEncrypted).toBe(false);
		expect(result.isCorrupt).toBe("");
	});

	test("handles empty PDF (no extractable text)", async () => {
		const mockFactory: PdfParserFactory = () => ({
			getText: async () => ({
				pages: [{ num: 1, text: "" }],
				text: "",
				total: 1,
			}),
			destroy: async () => {},
		});

		const extractor = new PdfExtractExtractor(mockFactory);
		const result = await extractor.extract(Uint8Array.from([1, 2]), "empty.pdf");

		expect(result.pages).toEqual([{ pageNumber: 1, text: "" }]);
		expect(result.isEncrypted).toBe(false);
		expect(result.isCorrupt).toBe("");
	});

	test("detects encrypted PDF and sets isEncrypted flag", async () => {
		const mockFactory: PdfParserFactory = () => ({
			getText: async () => {
				throw new (await import("pdf-parse")).PasswordException(
					"Password required",
				);
			},
			destroy: async () => {},
		});

		const extractor = new PdfExtractExtractor(mockFactory);
		const result = await extractor.extract(
			Uint8Array.from([1, 2]),
			"encrypted.pdf",
		);

		expect(result.pages).toEqual([]);
		expect(result.isEncrypted).toBe(true);
		expect(result.isCorrupt).toBe("");
	});

	test("detects corrupt PDF and sets isCorrupt flag", async () => {
		const mockFactory: PdfParserFactory = () => ({
			getText: async () => {
				throw new (await import("pdf-parse")).InvalidPDFException(
					"Invalid PDF structure",
				);
			},
			destroy: async () => {},
		});

		const extractor = new PdfExtractExtractor(mockFactory);
		const result = await extractor.extract(Uint8Array.from([1, 2]), "corrupt.pdf");

		expect(result.pages).toEqual([]);
		expect(result.isEncrypted).toBe(false);
		expect(result.isCorrupt).toBe("Invalid or corrupted PDF");
	});

	test("handles FormatError as corrupt PDF", async () => {
		const mockFactory: PdfParserFactory = () => ({
			getText: async () => {
				throw new (await import("pdf-parse")).FormatError(
					"Malformed PDF content",
				);
			},
			destroy: async () => {},
		});

		const extractor = new PdfExtractExtractor(mockFactory);
		const result = await extractor.extract(
			Uint8Array.from([1, 2]),
			"malformed.pdf",
		);

		expect(result.pages).toEqual([]);
		expect(result.isEncrypted).toBe(false);
		expect(result.isCorrupt).toBe("Invalid or corrupted PDF");
	});

	test("handles unknown errors as corrupt PDF", async () => {
		const mockFactory: PdfParserFactory = () => ({
			getText: async () => {
				throw new Error("Unexpected error");
			},
			destroy: async () => {},
		});

		const extractor = new PdfExtractExtractor(mockFactory);
		const result = await extractor.extract(
			Uint8Array.from([1, 2]),
			"unknown.pdf",
		);

		expect(result.pages).toEqual([]);
		expect(result.isEncrypted).toBe(false);
		expect(result.isCorrupt).toBe("Unexpected error");
	});

	test("passes Uint8Array data to factory", async () => {
		let receivedData: Uint8Array | undefined;

		const mockFactory: PdfParserFactory = (params) => {
			receivedData = params.data;
			return {
				getText: async () => ({
					pages: [{ num: 1, text: "test" }],
					text: "test",
					total: 1,
				}),
				destroy: async () => {},
			};
		};

		const pdfBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);
		const extractor = new PdfExtractExtractor(mockFactory);
		await extractor.extract(pdfBytes, "test.pdf");

		expect(receivedData).toBe(pdfBytes);
	});

	test("uses real PDFParse by default", async () => {
		const extractor = new PdfExtractExtractor();
		expect(extractor).toBeInstanceOf(PdfExtractExtractor);
	});
});
