import type { AppConfig } from "../config";
import { createPdfCapability, type PdfCapabilityOptions } from "./pdf/capability";
import {
	createSpreadsheetCapability,
	type SpreadsheetCapabilityOptions,
} from "./spreadsheet/capability";
import type {
	CapabilityInput,
	CapabilityResult,
	FileCapability,
	FileMetadata,
} from "./types";
import { createVoiceCapability, type VoiceCapabilityOptions } from "./voice/capability";

export type CapabilityRegistryOptions = {
	voice?: VoiceCapabilityOptions;
	pdf?: PdfCapabilityOptions;
	spreadsheet?: SpreadsheetCapabilityOptions;
	extra?: readonly FileCapability[];
};

export type FileDownloader = () => Promise<Uint8Array>;

export class CapabilityRegistry {
	constructor(private readonly capabilities: readonly FileCapability[]) {}

	match(metadata: FileMetadata): FileCapability | null {
		return this.capabilities.find((c) => c.canHandle(metadata)) ?? null;
	}

	async handle(
		metadata: FileMetadata,
		download: FileDownloader,
	): Promise<CapabilityResult> {
		const capability = this.match(metadata);
		if (capability === null) {
			return {
				ok: false,
				userMessage: formatUnsupportedMessage(metadata),
			};
		}

		if (capability.prevalidate) {
			const pre = capability.prevalidate(metadata);
			if (pre !== null && pre !== undefined) return pre;
		}

		let bytes: Uint8Array;
		try {
			bytes = await download();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, userMessage: `Failed to download file: ${message}` };
		}

		return this.processWith(capability, { bytes, metadata });
	}

	async processWith(
		capability: FileCapability,
		input: CapabilityInput,
	): Promise<CapabilityResult> {
		try {
			return await capability.process(input);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				userMessage: `Failed to process ${capability.name}: ${message}`,
			};
		}
	}
}

function formatUnsupportedMessage(metadata: FileMetadata): string {
	const descriptor =
		metadata.mimeType && metadata.mimeType !== ""
			? metadata.mimeType
			: (metadata.filename ?? "unknown");
	return `Unsupported file type: ${descriptor}.`;
}

export function createCapabilityRegistry(
	config: AppConfig,
	options: CapabilityRegistryOptions = {},
): CapabilityRegistry {
	const capabilities: FileCapability[] = [];
	const voice = createVoiceCapability(config, options.voice);
	if (voice) capabilities.push(voice);
	const pdf = createPdfCapability(config, options.pdf);
	if (pdf) capabilities.push(pdf);
	const sheet = createSpreadsheetCapability(config, options.spreadsheet);
	if (sheet) capabilities.push(sheet);
	if (options.extra) capabilities.push(...options.extra);
	return new CapabilityRegistry(capabilities);
}
