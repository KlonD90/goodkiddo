import type { AppConfig } from "../config";
import {
	type AttachmentBudgetConfig,
	type AttachmentBudgetDecision,
	decideAttachmentBudget,
	estimateAttachmentTokens,
} from "./attachment_budget";
import {
	createPdfCapability,
	type PdfCapabilityOptions,
} from "./pdf/capability";
import {
	createSpreadsheetCapability,
	type SpreadsheetCapabilityOptions,
} from "./spreadsheet/capability";
import { createTextFileCapability } from "./text/capability";
import type {
	CapabilityInput,
	CapabilityResult,
	FileCapability,
	FileMetadata,
} from "./types";
import {
	createVoiceCapability,
	type VoiceCapabilityOptions,
} from "./voice/capability";

export type CapabilityRegistryOptions = {
	voice?: VoiceCapabilityOptions;
	pdf?: PdfCapabilityOptions;
	spreadsheet?: SpreadsheetCapabilityOptions;
	extra?: readonly FileCapability[];
};

export type FileDownloader = () => Promise<Uint8Array>;

export type CapabilityHandleBudget = {
	config: AttachmentBudgetConfig;
	currentRuntimeTokens: number;
	compact: () => Promise<void>;
};

export class CapabilityRegistry {
	constructor(private readonly capabilities: readonly FileCapability[]) {}

	match(metadata: FileMetadata): FileCapability | null {
		return this.capabilities.find((c) => c.canHandle(metadata)) ?? null;
	}

	async handle(
		metadata: FileMetadata,
		download: FileDownloader,
		budget?: CapabilityHandleBudget,
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

		const result = await this.processWith(capability, { bytes, metadata });
		return applyAttachmentBudgetToResult(capability.name, result, budget);
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

export async function applyAttachmentBudgetToResult(
	capabilityName: string,
	result: CapabilityResult,
	budget?: CapabilityHandleBudget,
): Promise<CapabilityResult> {
	if (!result.ok || budget === undefined) {
		return result;
	}

	const attachmentTokens = estimateAttachmentTokens(result.value);
	const decision = decideAttachmentBudget({
		attachmentTokens,
		currentRuntimeTokens: budget.currentRuntimeTokens,
		config: budget.config,
	});

	if (decision.kind === "reject") {
		return {
			ok: false,
			userMessage: formatTooLargeMessage(capabilityName, decision),
		};
	}

	if (decision.kind === "compact_then_inject") {
		await budget.compact();
	}

	return result;
}

export function formatTooLargeMessage(
	capabilityName: string,
	decision: Pick<
		Extract<AttachmentBudgetDecision, { kind: "reject" }>,
		"attachmentTokens" | "maxTokens"
	>,
): string {
	const attachmentType = userFacingAttachmentType(capabilityName);
	return `This ${attachmentType} is too large for a single turn (≈${decision.attachmentTokens} tokens, max ${decision.maxTokens}). Please send a smaller file or split it.`;
}

function userFacingAttachmentType(capabilityName: string): string {
	switch (capabilityName.toLowerCase()) {
		case "pdf":
			return "PDF";
		case "spreadsheet":
			return "spreadsheet";
		case "voice":
			return "voice message";
		case "text_file":
			return "text file";
		default:
			return capabilityName;
	}
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
	// text_file is last — it's a broad catch-all for text/* and code extensions
	capabilities.push(createTextFileCapability());
	if (options.extra) capabilities.push(...options.extra);
	return new CapabilityRegistry(capabilities);
}
