import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../../backends";
import type { AppConfig } from "../../config";
import {
	buildIncomingImagePromptText,
	buildTelegramPhotoUserInput,
	extractIncomingExtension,
} from "./files";

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
	maxContextWindowTokens: 150_000,
	contextReserveSummaryTokens: 4_000,
	contextReserveRecentTurnTokens: 8_000,
	contextReserveNextTurnTokens: 8_000,
	permissionsMode: "disabled",
	databaseUrl: "sqlite://:memory:",
	enableExecute: false,
	enableVoiceMessages: true,
	enablePdfDocuments: true,
	enableSpreadsheets: true,
	enableImageUnderstanding: false,
	enableToolStatus: true,
	enableAttachmentCompactionNotice: true,
	defaultStatusLocale: "en",
	transcriptionProvider: "openai",
	transcriptionApiKey: "test-key",
	transcriptionBaseUrl: "",
	minimaxApiKey: "",
	minimaxApiHost: "https://api.minimax.io",
	webHost: "127.0.0.1",
	webPort: 8083,
	webPublicBaseUrl: "http://localhost:8083",
	timezone: "UTC",
};

describe("extractIncomingExtension", () => {
	test("extracts known image extensions in lowercase", () => {
		expect(extractIncomingExtension("photos/file.PNG")).toBe("png");
		expect(extractIncomingExtension("file.webp")).toBe("webp");
		expect(extractIncomingExtension("file.gif")).toBe("gif");
	});

	test("falls back to jpg for unknown or missing extensions", () => {
		expect(extractIncomingExtension(undefined)).toBe("jpg");
		expect(extractIncomingExtension("")).toBe("jpg");
		expect(extractIncomingExtension("file")).toBe("jpg");
		expect(extractIncomingExtension("file.tiff")).toBe("jpg");
	});

	test("falls back to jpg for paths with unsafe characters in extension", () => {
		expect(extractIncomingExtension("file.png;rm")).toBe("jpg");
	});
});

describe("buildTelegramPhotoUserInput", () => {
	test("stores images under /incoming and prompts the agent to call understand_image when enabled", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		const backend = new SqliteStateBackend({
			db,
			dialect: "sqlite",
			namespace: "photo-test-enabled",
		});
		const bytes = Uint8Array.from([0xff, 0xd8, 0xff]);

		try {
			const content = await buildTelegramPhotoUserInput(
				{
					...BASE_CONFIG,
					enableImageUnderstanding: true,
					minimaxApiKey: "minimax-secret",
				},
				backend,
				bytes,
				{
					caption: "what does this say?",
					filePath: "photos/file.PNG",
				},
			);

			expect(typeof content).toBe("string");
			const text = String(content);
			expect(text).toContain("understand_image");
			expect(text).toContain('Caption: "what does this say?"');
			const [imagePath] = text.match(/\/incoming\/[^\s.]+\.png/u) ?? [];
			expect(imagePath).toBeDefined();

			const [downloaded] = await backend.downloadFiles([imagePath ?? ""]);
			expect(downloaded.error).toBeNull();
			expect(downloaded.content).toEqual(bytes);
		} finally {
			await db.close();
		}
	});

	test("keeps raw image content when image understanding is disabled", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		const backend = new SqliteStateBackend({
			db,
			dialect: "sqlite",
			namespace: "photo-test-disabled",
		});
		const bytes = Uint8Array.from([1, 2, 3]);

		try {
			const content = await buildTelegramPhotoUserInput(
				BASE_CONFIG,
				backend,
				bytes,
				{
					caption: "what is in this photo?",
					filePath: "photos/cat.png",
				},
			);

			expect(content).toEqual([
				{
					type: "text",
					text: "what is in this photo?",
				},
				{
					type: "image",
					mimeType: "image/png",
					data: bytes,
				},
			]);
		} finally {
			await db.close();
		}
	});
});

describe("buildIncomingImagePromptText", () => {
	test("includes the caption when one was provided", () => {
		const text = buildIncomingImagePromptText(
			"/incoming/123-abc.jpg",
			"what does this say?",
		);
		expect(text).toContain("/incoming/123-abc.jpg");
		expect(text).toContain('Caption: "what does this say?"');
		expect(text).toContain("understand_image");
	});

	test("omits the caption clause when caption is empty", () => {
		const text = buildIncomingImagePromptText("/incoming/x.jpg", "");
		expect(text).not.toContain("Caption:");
		expect(text).toContain("/incoming/x.jpg");
		expect(text).toContain("understand_image");
	});

	test("trims whitespace-only captions", () => {
		const text = buildIncomingImagePromptText("/incoming/x.jpg", "   ");
		expect(text).not.toContain("Caption:");
	});
});
