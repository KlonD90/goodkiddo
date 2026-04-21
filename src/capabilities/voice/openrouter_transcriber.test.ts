import { afterEach, describe, expect, test } from "bun:test";
import { OpenRouterTranscriber } from "./openrouter_transcriber";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("OpenRouterTranscriber", () => {
	test("sends audio to chat completions with input_audio content", async () => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;

		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requestUrl = String(input);
			requestInit = init;
			return Response.json({
				choices: [
					{
						message: {
							content: "hello world",
						},
					},
				],
			});
		}) as unknown as typeof fetch;

		const transcriber = new OpenRouterTranscriber({
			apiKey: "voice-key",
			baseUrl: "https://openrouter.example/api/v1",
			modelName: "openai/gpt-4o-mini-transcribe",
		});

		await expect(
			transcriber.transcribe(Uint8Array.from([1, 2, 3]), "audio/ogg"),
		).resolves.toBe("hello world");

		expect(requestUrl).toBe("https://openrouter.example/api/v1/chat/completions");
		expect(requestInit?.method).toBe("POST");
		expect((requestInit?.headers as Record<string, string>)?.Authorization).toBe(
			"Bearer voice-key",
		);
		expect((requestInit?.headers as Record<string, string>)?.["Content-Type"]).toBe(
			"application/json",
		);

		const payload = JSON.parse(String(requestInit?.body)) as {
			model: string;
			messages: Array<{
				role: string;
				content: Array<
					| { type: "text"; text: string }
					| {
							type: "input_audio";
							input_audio: { data: string; format: string };
					  }
				>;
			}>;
		};
		expect(payload.model).toBe("openai/gpt-4o-mini-transcribe");
		expect(payload.messages[0]?.role).toBe("user");
		expect(payload.messages[0]?.content[0]).toEqual({
			type: "text",
			text: "Transcribe this audio verbatim. Return only the transcript text.",
		});
		expect(payload.messages[0]?.content[1]).toEqual({
			type: "input_audio",
			input_audio: {
				data: "AQID",
				format: "ogg",
			},
		});
	});

	test("extracts transcript text from array content responses", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				choices: [
					{
						message: {
							content: [{ type: "text", text: "hello array world" }],
						},
					},
				],
			})) as unknown as typeof fetch;

		const transcriber = new OpenRouterTranscriber({ apiKey: "voice-key" });

		await expect(
			transcriber.transcribe(Uint8Array.from([9]), "audio/ogg"),
		).resolves.toBe("hello array world");
	});

	test("maps API errors to a transcription request failure", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: { message: "rate limited" } }), {
				status: 429,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;

		const transcriber = new OpenRouterTranscriber({ apiKey: "voice-key" });

		await expect(
			transcriber.transcribe(Uint8Array.from([9]), "audio/ogg"),
		).rejects.toThrow("Transcription request failed: rate limited");
	});

	test("rejects a success payload that does not include text", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				choices: [{ message: { content: [] } }],
			})) as unknown as typeof fetch;

		const transcriber = new OpenRouterTranscriber({ apiKey: "voice-key" });

		await expect(
			transcriber.transcribe(Uint8Array.from([9]), "audio/ogg"),
		).rejects.toThrow(
			"Transcription request failed: Transcription response did not include text.",
		);
	});
});
