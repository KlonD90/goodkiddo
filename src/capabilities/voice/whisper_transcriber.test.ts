import { afterEach, describe, expect, test } from "bun:test";
import { WhisperTranscriber } from "./whisper_transcriber";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("WhisperTranscriber", () => {
	test("transcribes audio via the configured OpenAI-compatible endpoint", async () => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;

		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requestUrl = String(input);
			requestInit = init;
			return Response.json({ text: "hello world" });
		}) as unknown as typeof fetch;

		const transcriber = new WhisperTranscriber({
			apiKey: "voice-key",
			baseUrl: "https://openrouter.example/api/v1",
			modelName: "openai/whisper-1",
		});

		await expect(
			transcriber.transcribe(Uint8Array.from([1, 2, 3]), "audio/ogg"),
		).resolves.toBe("hello world");

		expect(requestUrl).toBe(
			"https://openrouter.example/api/v1/audio/transcriptions",
		);
		expect(requestInit?.method).toBe("POST");
		expect((requestInit?.headers as Record<string, string>)?.Authorization).toBe(
			"Bearer voice-key",
		);

		const formData = requestInit?.body;
		expect(formData).toBeInstanceOf(FormData);
		expect((formData as FormData).get("model")).toBe("openai/whisper-1");

		const file = (formData as FormData).get("file");
		expect(file).toBeInstanceOf(File);
		expect((file as File).type).toBe("audio/ogg");
		expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(
			Uint8Array.from([1, 2, 3]),
		);
	});

	test("maps API errors to a transcription request failure", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: { message: "rate limited" } }), {
				status: 429,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;

		const transcriber = new WhisperTranscriber({ apiKey: "voice-key" });

		await expect(
			transcriber.transcribe(Uint8Array.from([9]), "audio/ogg"),
		).rejects.toThrow("Transcription request failed: rate limited");
	});

	test("maps network errors to a transcription request failure", async () => {
		globalThis.fetch = (async () => {
			throw new Error("socket hang up");
		}) as unknown as typeof fetch;

		const transcriber = new WhisperTranscriber({ apiKey: "voice-key" });

		await expect(
			transcriber.transcribe(Uint8Array.from([9]), "audio/ogg"),
		).rejects.toThrow("Transcription request failed: socket hang up");
	});
});
