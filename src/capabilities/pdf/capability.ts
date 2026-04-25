import type { AppConfig } from "../../config";
import type {
	CapabilityInput,
	CapabilityResult,
	FileCapability,
	FileMetadata,
} from "../types";
import { PDF_MAX_BYTES } from "./constants";
import { buildPdfContent, buildPdfText } from "./content";
import type { PdfExtractor } from "./extractor";
import { PdfExtractExtractor } from "./pdf_extract_extractor";

export type PdfCapabilityOptions = {
	extractor?: PdfExtractor;
};

export function createPdfCapability(
	config: AppConfig,
	options: PdfCapabilityOptions = {},
): FileCapability | null {
	if (config.enablePdfDocuments === false) return null;
	const extractor = options.extractor ?? new PdfExtractExtractor();

	return {
		name: "pdf",
		canHandle,
		prevalidate,
		process: (input) => processPdf(extractor, input),
	};
}

function canHandle(metadata: FileMetadata): boolean {
	if (metadata.mimeType === "application/pdf") return true;
	return typeof metadata.filename === "string" && /\.pdf$/i.test(metadata.filename);
}

function prevalidate(metadata: FileMetadata): CapabilityResult | null {
	if (metadata.byteSize === undefined) {
		return {
			ok: false,
			userMessage:
				"PDF file size is unknown. Please try again or send a different file.",
		};
	}
	if (metadata.byteSize > PDF_MAX_BYTES) {
		return { ok: false, userMessage: "PDF is too large (max 20 MB)." };
	}
	return null;
}

async function processPdf(
	extractor: PdfExtractor,
	input: CapabilityInput,
): Promise<CapabilityResult> {
	const filename = input.metadata.filename ?? "document.pdf";
	const result = await extractor.extract(input.bytes, filename);

	if (result.isEncrypted) {
		return {
			ok: false,
			userMessage: "This PDF is password-protected and cannot be read.",
		};
	}

	if (result.isCorrupt !== "") {
		return {
			ok: false,
			userMessage: `Failed to read PDF: ${result.isCorrupt}`,
		};
	}

	const allPagesEmpty = result.pages.every((page) => page.text.trim() === "");
	if (allPagesEmpty) {
		return {
			ok: false,
			userMessage: "This PDF appears to contain no text.",
		};
	}

	return {
		ok: true,
		value: {
			content: buildPdfContent(result.pages, filename),
			currentUserText: buildPdfText(result.pages),
		},
	};
}
