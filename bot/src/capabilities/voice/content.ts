function normalizeVoiceParts(
	text: string,
	caption?: string | null,
): { transcript: string; normalizedCaption: string } {
	return {
		transcript: text.trim(),
		normalizedCaption: typeof caption === "string" ? caption.trim() : "",
	};
}

export function buildVoiceTurnText(
	text: string,
	caption?: string | null,
): string {
	const { transcript, normalizedCaption } = normalizeVoiceParts(text, caption);
	return normalizedCaption === ""
		? transcript
		: `${transcript}\n\n${normalizedCaption}`;
}

export function buildVoiceContent(
	text: string,
	caption?: string | null,
): string {
	const { transcript, normalizedCaption } = normalizeVoiceParts(text, caption);
	const transcriptContent = `_Transcribed: ${transcript}_`;

	return normalizedCaption === ""
		? transcriptContent
		: `${transcriptContent}\n\n${normalizedCaption}`;
}
