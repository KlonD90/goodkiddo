export function buildVoiceContent(
	text: string,
	caption?: string | null,
): string {
	const transcript = text.trim();
	const normalizedCaption = typeof caption === "string" ? caption.trim() : "";
	const transcriptContent = `_Transcribed: ${transcript}_`;

	return normalizedCaption === ""
		? transcriptContent
		: `${transcriptContent}\n\n${normalizedCaption}`;
}
