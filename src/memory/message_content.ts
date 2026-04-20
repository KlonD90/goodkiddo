const CHARS_PER_TOKEN = 4;
const NON_TEXT_BLOCK_TOKEN_COST = 1024;

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function hasBinaryPayload(value: unknown): boolean {
	return (
		value instanceof Uint8Array ||
		value instanceof ArrayBuffer ||
		ArrayBuffer.isView(value)
	);
}

function isNonTextContentBlock(record: Record<string, unknown>): boolean {
	const type = typeof record.type === "string" ? record.type : "";
	if (
		type === "image" ||
		type === "input_image" ||
		type === "audio" ||
		type === "input_audio" ||
		type === "file"
	) {
		return true;
	}

	const mimeType =
		typeof record.mimeType === "string"
			? record.mimeType
			: typeof record.mime_type === "string"
				? record.mime_type
				: "";
	if (mimeType !== "" && !mimeType.startsWith("text/")) {
		return true;
	}

	if ("image_url" in record || "audio_url" in record || "file_id" in record) {
		return true;
	}

	return hasBinaryPayload(record.data);
}

export function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((part) => extractContentText(part)).join("");
	}
	if (typeof content === "object" && content !== null) {
		if ("text" in content) {
			const text = (content as { text?: unknown }).text;
			if (typeof text === "string") return text;
		}
		if ("content" in content) {
			return extractContentText((content as { content?: unknown }).content);
		}
	}
	return "";
}

export function estimateContentTokens(content: unknown): number {
	if (typeof content === "string") return estimateTextTokens(content);
	if (Array.isArray(content)) {
		return content.reduce((sum, part) => sum + estimateContentTokens(part), 0);
	}
	if (typeof content === "object" && content !== null) {
		const record = content as Record<string, unknown>;
		let total = 0;

		if (typeof record.text === "string") {
			total += estimateTextTokens(record.text);
		}

		if ("content" in record) {
			total += estimateContentTokens(record.content);
		}

		if (isNonTextContentBlock(record)) {
			total += NON_TEXT_BLOCK_TOKEN_COST;
		}

		return total;
	}
	return 0;
}
