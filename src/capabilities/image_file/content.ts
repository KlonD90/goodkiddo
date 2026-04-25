import type { CapabilityContent } from "../types";

export function buildImageContent(
	imageData: Uint8Array,
	mimeType: string,
	caption: string,
): CapabilityContent {
	return [
		{
			type: "text",
			text: caption === "" ? "User attached an image without a caption." : caption,
		},
		{
			type: "image",
			mimeType,
			data: imageData,
		},
	];
}

export function buildImageTurnText(caption: string): string {
	return caption === "" ? "User attached an image." : caption;
}
