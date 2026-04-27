import type { AppConfig } from "../../config";
import { canReusePrimaryAiCredentialsForTranscription } from "../../config";
import type {
	CapabilityInput,
	CapabilityResult,
	FileCapability,
	FileMetadata,
} from "../types";
import { VOICE_MAX_BYTES } from "./constants";
import { buildVoiceContent, buildVoiceTurnText } from "./content";
import { OpenRouterTranscriber } from "./openrouter_transcriber";
import type { Transcriber } from "./transcriber";
import { WhisperTranscriber } from "./whisper_transcriber";

export type VoiceCapabilityOptions = {
	transcriber?: Transcriber;
};

const VOICE_MIME_TYPES = new Set([
	"audio/ogg",
	"audio/mpeg",
	"audio/mp4",
	"audio/wav",
	"audio/webm",
	"audio/x-m4a",
]);

const VOICE_FILENAME_EXTENSIONS = /\.(ogg|oga|mp3|m4a|wav|webm)$/i;

export function createVoiceCapability(
	config: AppConfig,
	options: VoiceCapabilityOptions = {},
): FileCapability | null {
	if (config.enableVoiceMessages === false) return null;
	const transcriber = options.transcriber ?? buildDefaultTranscriber(config);
	if (transcriber === null) return null;

	return {
		name: "voice",
		canHandle,
		prevalidate,
		process: (input) => processVoice(transcriber, input),
	};
}

function canHandle(metadata: FileMetadata): boolean {
	const mime = normalizeMime(metadata.mimeType);
	if (mime !== undefined && VOICE_MIME_TYPES.has(mime)) return true;
	if (typeof metadata.filename === "string" && VOICE_FILENAME_EXTENSIONS.test(metadata.filename)) {
		return true;
	}
	return false;
}

function prevalidate(metadata: FileMetadata): CapabilityResult | null {
	if (metadata.byteSize === undefined) {
		return {
			ok: false,
			userMessage:
				"Voice message file size is unknown. Please try again or send a text message.",
		};
	}
	if (metadata.byteSize > VOICE_MAX_BYTES) {
		return { ok: false, userMessage: "Voice message is too large" };
	}
	return null;
}

async function processVoice(
	transcriber: Transcriber,
	input: CapabilityInput,
): Promise<CapabilityResult> {
	const { bytes, metadata } = input;
	const mimeType = normalizeMime(metadata.mimeType) ?? "audio/ogg";

	let transcript: string;
	try {
		transcript = await transcriber.transcribe(bytes, mimeType);
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Unknown voice transcription error";
		return { ok: false, userMessage: `Transcription failed: ${message}` };
	}

	return {
		ok: true,
		value: {
			content: buildVoiceContent(transcript, metadata.caption),
			currentUserText: buildVoiceTurnText(transcript, metadata.caption),
			commandText: transcript.trim(),
		},
	};
}

function normalizeMime(value: string | undefined): string | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	return value.split(";", 1)[0]?.trim().toLowerCase();
}

function buildDefaultTranscriber(config: AppConfig): Transcriber | null {
	const hasReusableCredentials = canReusePrimaryAiCredentialsForTranscription(
		config.aiType,
		config.transcriptionProvider,
	);
	const hasDedicatedKey =
		config.transcriptionApiKey !== undefined && config.transcriptionApiKey !== "";
	if (!hasReusableCredentials && !hasDedicatedKey) return null;

	switch (config.transcriptionProvider) {
		case "openai":
			return new WhisperTranscriber({
				apiKey: config.transcriptionApiKey,
				baseUrl: config.transcriptionBaseUrl || undefined,
			});
		case "openrouter":
			return new OpenRouterTranscriber({
				apiKey: config.transcriptionApiKey,
				baseUrl: config.transcriptionBaseUrl || undefined,
			});
		default:
			return null;
	}
}
