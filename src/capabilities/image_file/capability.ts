import type { AppConfig } from "../../config";
import type {
	CapabilityInput,
	CapabilityResult,
	FileCapability,
	FileMetadata,
} from "../types";
import { buildImageContent, buildImageTurnText } from "./content";

const IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/gif",
	"image/webp",
	"image/bmp",
	"image/svg+xml",
]);

const IMAGE_FILENAME_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

export type ImageFileCapabilityOptions = Record<string, never>;

export function createImageFileCapability(
	_config: AppConfig,
	_options: ImageFileCapabilityOptions = {},
): FileCapability | null {
	return {
		name: "image",
		canHandle,
		process: (input) => processImage(input),
	};
}

function canHandle(metadata: FileMetadata): boolean {
	const mime = normalizeMime(metadata.mimeType);
	if (mime !== undefined && IMAGE_MIME_TYPES.has(mime)) return true;
	if (typeof metadata.filename === "string" && IMAGE_FILENAME_EXTENSIONS.test(metadata.filename)) {
		return true;
	}
	return false;
}

function normalizeMime(value: string | undefined): string | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	return value.split(";", 1)[0]?.trim().toLowerCase();
}

async function processImage(input: CapabilityInput): Promise<CapabilityResult> {
	const { bytes, metadata } = input;
	const mimeType = normalizeMime(metadata.mimeType) ?? "image/png";
	const caption = typeof metadata.caption === "string" ? metadata.caption.trim() : "";

	return {
		ok: true,
		value: {
			content: buildImageContent(bytes, mimeType, caption),
			currentUserText: buildImageTurnText(caption),
		},
	};
}
