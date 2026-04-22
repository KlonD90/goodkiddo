import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../../config";
import { createPdfCapability } from "./capability";
import type { PdfExtractionResult, PdfExtractor } from "./extractor";

const BASE_CONFIG: AppConfig = {
	aiApiKey: "test-key",
	aiBaseUrl: "",
	aiType: "openai",
	aiModelName: "gpt-4o-mini",
	appEntrypoint: "telegram",
	telegramBotToken: "telegram-token",
	telegramAllowedChatId: "",
	usingMode: "single",
	blockedUserMessage: "blocked",
	permissionsMode: "disabled",
	databaseUrl: "sqlite://:memory:",
	enableExecute: false,
	enablePdfDocuments: true,
	enableSpreadsheets: true,
	enableToolStatus: true,
	enableAttachmentCompactionNotice: true,
	defaultStatusLocale: "en",
	enableVoiceMessages: true,
	transcriptionProvider: "openai",
	transcriptionApiKey: "transcription-key",
	transcriptionBaseUrl: "",
	webPort: 8083,
	webPublicBaseUrl: "http://localhost:8083",
	timezone: "UTC",
} as AppConfig;

class StubPdfExtractor implements PdfExtractor {
	constructor(private readonly result: PdfExtractionResult) {}
	async extract(): Promise<PdfExtractionResult> {
		return this.result;
	}
}

describe("createPdfCapability", () => {
	test("returns null when PDF documents are disabled", () => {
		const capability = createPdfCapability({
			...BASE_CONFIG,
			enablePdfDocuments: false,
		});
		expect(capability).toBeNull();
	});

	test("canHandle matches application/pdf mime type and .pdf filename", () => {
		const capability = createPdfCapability(BASE_CONFIG, {
			extractor: new StubPdfExtractor({
				pages: [],
				isEncrypted: false,
				isCorrupt: "",
			}),
		})!;
		expect(capability.canHandle({ mimeType: "application/pdf" })).toBe(true);
		expect(capability.canHandle({ filename: "Report.PDF" })).toBe(true);
		expect(capability.canHandle({ mimeType: "text/csv" })).toBe(false);
		expect(capability.canHandle({ filename: "doc.txt" })).toBe(false);
	});

	test("prevalidate rejects oversized and size-unknown PDFs", () => {
		const capability = createPdfCapability(BASE_CONFIG, {
			extractor: new StubPdfExtractor({
				pages: [],
				isEncrypted: false,
				isCorrupt: "",
			}),
		})!;
		expect(capability.prevalidate!({ mimeType: "application/pdf" })).toEqual({
			ok: false,
			userMessage:
				"PDF file size is unknown. Please try again or send a different file.",
		});
		expect(
			capability.prevalidate!({
				mimeType: "application/pdf",
				byteSize: 30 * 1024 * 1024,
			}),
		).toEqual({ ok: false, userMessage: "PDF is too large (max 20 MB)." });
		expect(
			capability.prevalidate!({ mimeType: "application/pdf", byteSize: 1024 }),
		).toBeNull();
	});

	test("process returns user messages for encrypted and corrupt PDFs", async () => {
		const encryptedCap = createPdfCapability(BASE_CONFIG, {
			extractor: new StubPdfExtractor({
				pages: [],
				isEncrypted: true,
				isCorrupt: "",
			}),
		})!;
		const encryptedResult = await encryptedCap.process({
			bytes: Uint8Array.from([1]),
			metadata: { mimeType: "application/pdf", byteSize: 1, filename: "a.pdf" },
		});
		expect(encryptedResult.ok).toBe(false);
		if (!encryptedResult.ok) {
			expect(encryptedResult.userMessage).toBe(
				"This PDF is password-protected and cannot be read.",
			);
		}

		const corruptCap = createPdfCapability(BASE_CONFIG, {
			extractor: new StubPdfExtractor({
				pages: [],
				isEncrypted: false,
				isCorrupt: "Invalid or corrupted PDF",
			}),
		})!;
		const corruptResult = await corruptCap.process({
			bytes: Uint8Array.from([1]),
			metadata: { mimeType: "application/pdf", byteSize: 1, filename: "a.pdf" },
		});
		expect(corruptResult.ok).toBe(false);
		if (!corruptResult.ok) {
			expect(corruptResult.userMessage).toBe(
				"Failed to read PDF: Invalid or corrupted PDF",
			);
		}
	});

	test("process rejects PDFs whose pages are all blank", async () => {
		const capability = createPdfCapability(BASE_CONFIG, {
			extractor: new StubPdfExtractor({
				pages: [
					{ pageNumber: 1, text: "  " },
					{ pageNumber: 2, text: "\n" },
				],
				isEncrypted: false,
				isCorrupt: "",
			}),
		})!;
		const result = await capability.process({
			bytes: Uint8Array.from([1]),
			metadata: { mimeType: "application/pdf", byteSize: 1, filename: "blank.pdf" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.userMessage).toBe("This PDF appears to contain no text.");
		}
	});

	test("process returns rendered content for a readable PDF", async () => {
		const capability = createPdfCapability(BASE_CONFIG, {
			extractor: new StubPdfExtractor({
				pages: [{ pageNumber: 1, text: "hello world" }],
				isEncrypted: false,
				isCorrupt: "",
			}),
		})!;
		const result = await capability.process({
			bytes: Uint8Array.from([1]),
			metadata: { mimeType: "application/pdf", byteSize: 1, filename: "doc.pdf" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.content).toContain("_Document: doc.pdf");
			expect(result.value.content).toContain("hello world");
			expect(result.value.currentUserText).toBe("hello world");
		}
	});
});
