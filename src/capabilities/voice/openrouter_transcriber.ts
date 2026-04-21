import type { Transcriber } from "./transcriber";

export type OpenRouterTranscriberOptions = {
	apiKey: string;
	baseUrl?: string;
	modelName?: string;
};

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/";
const DEFAULT_OPENROUTER_MODEL_NAME = "openai/whisper-1";
const DEFAULT_TRANSCRIPTION_PROMPT =
	"Transcribe this audio verbatim. Return only the transcript text.";

type OpenRouterChatCompletionResponse = {
	choices?: Array<{
		message?: {
			content?: unknown;
		};
	}>;
	error?: {
		message?: unknown;
	};
};

export class OpenRouterTranscriber implements Transcriber {
	private readonly apiKey: string;
	private readonly endpoint: string;
	private readonly modelName: string;

	constructor(options: OpenRouterTranscriberOptions) {
		this.apiKey = options.apiKey;
		this.endpoint = new URL(
			"chat/completions",
			ensureTrailingSlash(options.baseUrl || DEFAULT_OPENROUTER_BASE_URL),
		).toString();
		this.modelName = options.modelName || DEFAULT_OPENROUTER_MODEL_NAME;
	}

	async transcribe(audioBytes: Uint8Array, mimeType: string): Promise<string> {
		try {
			const response = await fetch(this.endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: this.modelName,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: DEFAULT_TRANSCRIPTION_PROMPT,
								},
								{
									type: "input_audio",
									input_audio: {
										data: encodeBase64(audioBytes),
										format: normalizeAudioFormat(mimeType),
									},
								},
							],
						},
					],
				}),
			});

			if (!response.ok) {
				throw new Error(await getTranscriptionErrorMessage(response));
			}

			const payload =
				(await response.json()) as OpenRouterChatCompletionResponse;
			const transcript = extractTranscriptText(payload);
			if (transcript === "") {
				throw new Error("Transcription response did not include text.");
			}

			return transcript;
		} catch (error) {
			throw new Error(prefixTranscriptionError(error));
		}
	}
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function encodeBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
		"base64",
	);
}

function normalizeAudioFormat(mimeType: string): string {
	const normalizedMimeType = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	switch (normalizedMimeType) {
		case "audio/mpeg":
			return "mp3";
		case "audio/mp4":
		case "audio/x-m4a":
			return "m4a";
		default: {
			const [, subtype = "wav"] = normalizedMimeType.split("/", 2);
			return subtype || "wav";
		}
	}
}

function extractTranscriptText(
	payload: OpenRouterChatCompletionResponse,
): string {
	const content = payload.choices?.[0]?.message?.content;
	if (typeof content === "string") {
		return content.trim();
	}

	if (Array.isArray(content)) {
		const text = content
			.flatMap((part) => {
				if (typeof part === "string") {
					return [part];
				}
				if (
					part &&
					typeof part === "object" &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string"
				) {
					return [part.text];
				}
				return [];
			})
			.join("")
			.trim();
		return text;
	}

	return "";
}

async function getTranscriptionErrorMessage(response: Response): Promise<string> {
	const body = (await response.text()).trim();
	if (body === "") {
		return `HTTP ${response.status}`;
	}

	try {
		const parsed = JSON.parse(body) as {
			error?: { message?: unknown };
			message?: unknown;
		};
		if (typeof parsed.error?.message === "string") {
			return parsed.error.message;
		}
		if (typeof parsed.message === "string") {
			return parsed.message;
		}
	} catch {
		// Fall back to the raw response body when the provider returns non-JSON errors.
	}

	return body;
}

function prefixTranscriptionError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.startsWith("Transcription request failed:")
		? message
		: `Transcription request failed: ${message}`;
}
