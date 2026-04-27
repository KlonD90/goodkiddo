export function compactInline(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
