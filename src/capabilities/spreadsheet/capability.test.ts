import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../../config";
import { createSpreadsheetCapability } from "./capability";
import type { SpreadsheetParser, SpreadsheetParseResult } from "./parser";

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

class StubSpreadsheetParser implements SpreadsheetParser {
	constructor(private readonly result: SpreadsheetParseResult) {}
	async parse(): Promise<SpreadsheetParseResult> {
		return this.result;
	}
}

describe("createSpreadsheetCapability", () => {
	test("returns null when spreadsheets are disabled", () => {
		const capability = createSpreadsheetCapability({
			...BASE_CONFIG,
			enableSpreadsheets: false,
		});
		expect(capability).toBeNull();
	});

	test("canHandle matches csv and excel mime types and filename extensions", () => {
		const capability = createSpreadsheetCapability(BASE_CONFIG, {
			parser: new StubSpreadsheetParser({
				sheets: [],
				isEmpty: true,
				isCorrupt: false,
			}),
		})!;

		expect(capability.canHandle({ mimeType: "text/csv" })).toBe(true);
		expect(capability.canHandle({ mimeType: "application/csv" })).toBe(true);
		expect(capability.canHandle({ mimeType: "application/vnd.ms-excel" })).toBe(true);
		expect(
			capability.canHandle({
				mimeType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			}),
		).toBe(true);
		expect(capability.canHandle({ filename: "Data.CSV" })).toBe(true);
		expect(capability.canHandle({ filename: "book.xlsx" })).toBe(true);
		expect(capability.canHandle({ filename: "book.xls" })).toBe(true);
		expect(capability.canHandle({ mimeType: "application/pdf" })).toBe(false);
		expect(capability.canHandle({ filename: "doc.pdf" })).toBe(false);
	});

	test("prevalidate rejects oversized and size-unknown spreadsheets", () => {
		const capability = createSpreadsheetCapability(BASE_CONFIG, {
			parser: new StubSpreadsheetParser({
				sheets: [],
				isEmpty: true,
				isCorrupt: false,
			}),
		})!;

		expect(capability.prevalidate!({ mimeType: "text/csv" })).toEqual({
			ok: false,
			userMessage:
				"Spreadsheet file size is unknown. Please try again or send a different file.",
		});
		expect(
			capability.prevalidate!({
				mimeType: "text/csv",
				byteSize: 20 * 1024 * 1024,
			}),
		).toEqual({
			ok: false,
			userMessage: "Spreadsheet is too large (max 10 MB).",
		});
		expect(
			capability.prevalidate!({ mimeType: "text/csv", byteSize: 1024 }),
		).toBeNull();
	});

	test("process returns user messages for corrupt and empty spreadsheets", async () => {
		const corruptCap = createSpreadsheetCapability(BASE_CONFIG, {
			parser: new StubSpreadsheetParser({
				sheets: [],
				isEmpty: false,
				isCorrupt: true,
				errorMessage: "bad zip",
			}),
		})!;
		const corruptResult = await corruptCap.process({
			bytes: Uint8Array.from([1]),
			metadata: { mimeType: "text/csv", byteSize: 1, filename: "a.csv" },
		});
		expect(corruptResult.ok).toBe(false);
		if (!corruptResult.ok) {
			expect(corruptResult.userMessage).toBe(
				"Failed to read spreadsheet: bad zip",
			);
		}

		const emptyCap = createSpreadsheetCapability(BASE_CONFIG, {
			parser: new StubSpreadsheetParser({
				sheets: [],
				isEmpty: true,
				isCorrupt: false,
			}),
		})!;
		const emptyResult = await emptyCap.process({
			bytes: Uint8Array.from([1]),
			metadata: { mimeType: "text/csv", byteSize: 1, filename: "a.csv" },
		});
		expect(emptyResult.ok).toBe(false);
		if (!emptyResult.ok) {
			expect(emptyResult.userMessage).toBe(
				"This spreadsheet appears to be empty.",
			);
		}
	});

	test("process renders a non-empty spreadsheet as markdown content", async () => {
		const capability = createSpreadsheetCapability(BASE_CONFIG, {
			parser: new StubSpreadsheetParser({
				sheets: [
					{
						name: "Sheet1",
						headers: ["Name", "Age"],
						rows: [
							["Alice", "30"],
							["Bob", "25"],
						],
						rowCount: 2,
						colCount: 2,
					},
				],
				isEmpty: false,
				isCorrupt: false,
			}),
		})!;

		const result = await capability.process({
			bytes: Uint8Array.from([1]),
			metadata: { mimeType: "text/csv", byteSize: 1, filename: "people.csv" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.content).toContain("_Spreadsheet: people.csv");
			expect(result.value.content).toContain("| Name | Age |");
			expect(result.value.content).toContain("| Alice | 30 |");
			expect(typeof result.value.content).toBe("string");
			if (typeof result.value.content === "string") {
				expect(result.value.currentUserText).toBe(result.value.content);
			}
		}
		});
	});
