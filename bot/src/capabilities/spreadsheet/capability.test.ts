import { describe, expect, test } from "bun:test";
import type { BackendProtocol } from "deepagents";
import type { AppConfig } from "../../config";
import { createSpreadsheetCapability } from "./capability";
import { TABULAR_INLINE_THRESHOLD_BYTES } from "./constants";
import type { SpreadsheetParser, SpreadsheetParseResult } from "./parser";

const BASE_CONFIG: AppConfig = {
	aiApiKey: "test-key",
	aiBaseUrl: "",
	aiType: "openai",
	aiModelName: "gpt-4o-mini",
	aiTemperature: 1.0,
	aiSubAgentTemperature: 0.4,
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
	enableImageUnderstanding: false,
	enableToolStatus: true,
	enableAttachmentCompactionNotice: true,
	defaultStatusLocale: "en",
	enableVoiceMessages: true,
	transcriptionProvider: "openai",
	transcriptionApiKey: "transcription-key",
	transcriptionBaseUrl: "",
	minimaxApiKey: "",
	minimaxApiHost: "https://api.minimax.io",
	webHost: "127.0.0.1",
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

class StubWorkspace implements Partial<BackendProtocol> {
	uploads: Array<[string, Uint8Array]> = [];
	async uploadFiles(files: Array<[string, Uint8Array]>): Promise<Array<{ path: string; error: string | null }>> {
		this.uploads.push(...files);
		return files.map(([path]) => ({ path, error: null }));
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

	test("process saves large spreadsheet to /incoming/ and returns path message when workspace is provided", async () => {
		const workspace = new StubWorkspace();
		const capability = createSpreadsheetCapability(BASE_CONFIG, {
			parser: new StubSpreadsheetParser({ sheets: [], isEmpty: false, isCorrupt: false }),
		})!;

		const bigBytes = new Uint8Array(TABULAR_INLINE_THRESHOLD_BYTES + 1);
		const result = await capability.process({
			bytes: bigBytes,
			metadata: { mimeType: "text/csv", byteSize: bigBytes.length, filename: "big.csv" },
			workspace: workspace as unknown as BackendProtocol,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(typeof result.value.content).toBe("string");
			const content = result.value.content as string;
			expect(content).toContain("/incoming/");
			expect(content).toContain("tabular_describe");
			expect(result.value.currentUserText).toBe(content);
		}
		expect(workspace.uploads).toHaveLength(1);
		expect(workspace.uploads[0][0]).toMatch(/^\/incoming\/.*\.csv$/);
	});

	test("process renders inline when file is below threshold even with workspace", async () => {
		const workspace = new StubWorkspace();
		const capability = createSpreadsheetCapability(BASE_CONFIG, {
			parser: new StubSpreadsheetParser({
				sheets: [
					{
						name: "Sheet1",
						headers: ["Name"],
						rows: [["Alice"]],
						rowCount: 1,
						colCount: 1,
					},
				],
				isEmpty: false,
				isCorrupt: false,
			}),
		})!;

		const smallBytes = new Uint8Array(10);
		const result = await capability.process({
			bytes: smallBytes,
			metadata: { mimeType: "text/csv", byteSize: smallBytes.length, filename: "small.csv" },
			workspace: workspace as unknown as BackendProtocol,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.content).toContain("| Name |");
		}
		expect(workspace.uploads).toHaveLength(0);
	});

	test("process renders inline when no workspace provided even for large file", async () => {
		const capability = createSpreadsheetCapability(BASE_CONFIG, {
			parser: new StubSpreadsheetParser({
				sheets: [
					{
						name: "Sheet1",
						headers: ["Name"],
						rows: [["Alice"]],
						rowCount: 1,
						colCount: 1,
					},
				],
				isEmpty: false,
				isCorrupt: false,
			}),
		})!;

		const bigBytes = new Uint8Array(TABULAR_INLINE_THRESHOLD_BYTES + 1);
		const result = await capability.process({
			bytes: bigBytes,
			metadata: { mimeType: "text/csv", byteSize: bigBytes.length, filename: "big.csv" },
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.content).toContain("| Name |");
		}
	});
});
