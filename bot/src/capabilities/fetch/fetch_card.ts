export type FetchCardInput = {
	noticed: string;
	prepared: string;
	missing?: string | null;
	source: string;
	body: string;
};

export function formatFetchCard(input: FetchCardInput): string {
	const missing = input.missing?.trim() || "none";

	return [
		"🐶 Fetched",
		`Noticed: ${input.noticed}`,
		`Prepared: ${input.prepared}`,
		`Missing: ${missing}`,
		`Source: ${input.source}`,
		"",
		input.body,
	].join("\n");
}
