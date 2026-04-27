export type SupportedAiTypes = "anthropic" | "openai" | "openrouter";
export const SUPPORTED_AI_TYPES: readonly SupportedAiTypes[] = [
	"anthropic",
	"openai",
	"openrouter",
];

export function checkAiType(type: string): type is SupportedAiTypes {
	return SUPPORTED_AI_TYPES.includes(type as SupportedAiTypes);
}

export type UsingMode = "single" | "multi";
export function checkUsingMode(mode: string): mode is UsingMode {
	return mode === "single" || mode === "multi";
}

export type AppEntrypoint = "cli" | "telegram";
export const SUPPORTED_APP_ENTRYPOINTS: readonly AppEntrypoint[] = [
	"cli",
	"telegram",
];

export function checkAppEntrypoint(value: string): value is AppEntrypoint {
	return SUPPORTED_APP_ENTRYPOINTS.includes(value as AppEntrypoint);
}
