import type { Transcriber } from "./transcriber";

export type WhisperTranscriberOptions = {
	apiKey: string;
	baseUrl?: string;
	modelName?: string;
};

const DEFAULT_WHISPER_BASE_URL = "https://api.openai.com/v1/";
const DEFAULT_WHISPER_MODEL_NAME = "whisper-1";

type WhisperTranscriptionResponse = {
	text?: unknown;
};

export class WhisperTranscriber implements Transcriber {
	private readonly apiKey: string;
	private readonly endpoint: string;
	private readonly modelName: string;

	constructor(options: WhisperTranscriberOptions) {
		this.apiKey = options.apiKey;
		this.endpoint = new URL(
			"audio/transcriptions",
			ensureTrailingSlash(options.baseUrl || DEFAULT_WHISPER_BASE_URL),
		).toString();
		this.modelName = options.modelName || DEFAULT_WHISPER_MODEL_NAME;
	}

	async transcribe(audioBytes: Uint8Array, mimeType: string): Promise<string> {
		const formData = new FormData();
		formData.set("model", this.modelName);
		formData.set("file", new File([audioBytes], "voice.ogg", { type: mimeType }));

		try {
			const response = await fetch(this.endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: formData,
			});

			if (!response.ok) {
				throw new Error(await getTranscriptionErrorMessage(response));
			}

			const payload = (await response.json()) as WhisperTranscriptionResponse;
			if (typeof payload.text !== "string") {
				throw new Error("Transcription response did not include text.");
			}

			return payload.text;
		} catch (error) {
			throw new Error(prefixTranscriptionError(error));
		}
	}
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
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
