import { describe, expect, test, vi } from "bun:test";
import type { CapabilityRegistry } from "../../capabilities/registry";
import type { FileCapability } from "../../capabilities/types";
import { SqliteStateBackend } from "../../backends";
import type { AppConfig } from "../../config";
import {
	buildIncomingImagePromptText,
	buildTelegramPhotoUserInput,
	extractIncomingExtension,
	processTelegramFile,
} from "./files";

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
	enableBrowserOnParent: false,
	enableTabular: true,
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
	recursionLimit: 60,
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

describe("processTelegramFile", () => {
	test("suppresses task and recall text for forwarded files", async () => {
		const capability = {
			name: "pdf",
			canHandle: () => true,
			process: async () => ({
				ok: true as const,
				value: {
					content: "continue the sales proposal",
					currentUserText: "continue the sales proposal",
				},
			}),
		} satisfies FileCapability;
		const registry = {
			match: () => capability,
			handle: async () => ({
				ok: true as const,
				value: {
					content: "continue the sales proposal",
					currentUserText: "continue the sales proposal",
				},
			}),
		} as unknown as CapabilityRegistry;
		const queued = vi.fn().mockResolvedValue(undefined);

		await processTelegramFile(
			BASE_CONFIG,
			registry,
			{ workspace: {} as never } as never,
			{} as never,
			"123",
			{ id: "telegram:123", entrypoint: "telegram", externalId: "123" },
			{} as never,
			undefined,
			{
				metadata: {
					mimeType: "application/pdf",
					filename: "proposal.pdf",
				},
				download: async () => Uint8Array.from([1]),
				contextPrefix: "[Telegram forwarded context]",
				contextIsForwarded: true,
			},
			{ queueTurn: queued },
		);

		expect(queued).toHaveBeenCalledTimes(1);
		expect(queued.mock.calls[0]?.[8]).toBeUndefined();
		expect(queued.mock.calls[0]?.[11]).toBeNull();
	});

	test("preserves recall text for replied voice messages", async () => {
		const capability = {
			name: "voice",
			canHandle: () => true,
			process: async () => ({
				ok: true as const,
				value: {
					content: "continue the sales proposal",
					currentUserText: "continue the sales proposal",
				},
			}),
		} satisfies FileCapability;
		const registry = {
			match: () => capability,
			handle: async () => ({
				ok: true as const,
				value: {
					content: "continue the sales proposal",
					currentUserText: "continue the sales proposal",
				},
			}),
		} as unknown as CapabilityRegistry;
		const queued = vi.fn().mockResolvedValue(undefined);

		await processTelegramFile(
			BASE_CONFIG,
			registry,
			{ workspace: {} as never } as never,
			{} as never,
			"123",
			{ id: "telegram:123", entrypoint: "telegram", externalId: "123" },
			{} as never,
			undefined,
			{
				metadata: {
					mimeType: "audio/ogg",
					filename: "voice.ogg",
				},
				download: async () => Uint8Array.from([1]),
				contextPrefix: "[Telegram reply context]",
				contextIsForwarded: false,
			},
			{ queueTurn: queued },
		);

		expect(queued).toHaveBeenCalledTimes(1);
		expect(queued.mock.calls[0]?.[3]).toBe("");
		expect(queued.mock.calls[0]?.[4]).toContain("[Telegram reply context]");
		expect(queued.mock.calls[0]?.[8]).toBe("continue the sales proposal");
		expect(queued.mock.calls[0]?.[11]).toBe("continue the sales proposal");
	});
});
