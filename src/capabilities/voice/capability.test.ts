import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../../config";
import { createVoiceCapability } from "./capability";
import type { Transcriber } from "./transcriber";

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

class StubTranscriber implements Transcriber {
	constructor(private readonly response: string | Error = "hello there") {}
	async transcribe(): Promise<string> {
		if (this.response instanceof Error) throw this.response;
		return this.response;
	}
}

describe("createVoiceCapability", () => {
	test("returns null when voice messages are disabled", () => {
		const capability = createVoiceCapability(
			{ ...BASE_CONFIG, enableVoiceMessages: false },
			{ transcriber: new StubTranscriber() },
		);
		expect(capability).toBeNull();
	});

	test("returns null when no transcriber is available and no credentials exist", () => {
		const capability = createVoiceCapability({
			...BASE_CONFIG,
			transcriptionApiKey: "",
			aiType: "anthropic",
			transcriptionProvider: "openai",
		});
		expect(capability).toBeNull();
	});

	test("canHandle matches known voice mime types and filename extensions", () => {
		const capability = createVoiceCapability(BASE_CONFIG, {
			transcriber: new StubTranscriber(),
		});
		expect(capability).not.toBeNull();

		expect(capability!.canHandle({ mimeType: "audio/ogg" })).toBe(true);
		expect(capability!.canHandle({ mimeType: "audio/mpeg" })).toBe(true);
		expect(capability!.canHandle({ filename: "note.ogg" })).toBe(true);
		expect(capability!.canHandle({ filename: "clip.mp3" })).toBe(true);
		expect(capability!.canHandle({ mimeType: "application/pdf" })).toBe(false);
		expect(capability!.canHandle({ filename: "report.pdf" })).toBe(false);
	});

	test("prevalidate rejects oversized and size-unknown voice messages", () => {
		const capability = createVoiceCapability(BASE_CONFIG, {
			transcriber: new StubTranscriber(),
		})!;

		expect(capability.prevalidate!({ mimeType: "audio/ogg" })).toEqual({
			ok: false,
			userMessage:
				"Voice message file size is unknown. Please try again or send a text message.",
		});
		expect(
			capability.prevalidate!({ mimeType: "audio/ogg", byteSize: 10_000_000 }),
		).toEqual({
			ok: false,
			userMessage: "Voice message is too large",
		});
		expect(
			capability.prevalidate!({ mimeType: "audio/ogg", byteSize: 512 }),
		).toBeNull();
	});

	test("process returns transcribed content with transcript as commandText", async () => {
		const capability = createVoiceCapability(BASE_CONFIG, {
			transcriber: new StubTranscriber("what is the weather"),
		})!;

		const result = await capability.process({
			bytes: Uint8Array.from([1, 2, 3]),
			metadata: { mimeType: "audio/ogg", byteSize: 3, caption: "extra note" },
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.content).toBe(
				"_Transcribed: what is the weather_\n\nextra note",
			);
			expect(result.value.currentUserText).toBe(
				"what is the weather\n\nextra note",
			);
			expect(result.value.commandText).toBe("what is the weather");
		}
	});

	test("process returns a user-facing error when the transcriber throws", async () => {
		const capability = createVoiceCapability(BASE_CONFIG, {
			transcriber: new StubTranscriber(new Error("boom")),
		})!;

		const result = await capability.process({
			bytes: Uint8Array.from([1]),
			metadata: { mimeType: "audio/ogg", byteSize: 1 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.userMessage).toBe("Transcription failed: boom");
	});
});
