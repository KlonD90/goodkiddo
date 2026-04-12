export type SupportedAiTypes = "anthropic" | "openai" | "openrouter";

export function checkAiType(type: string): type is SupportedAiTypes {
  return type === "anthropic" || type === "openai" || type === "openrouter";
}

export type UsingMode = "single" | "multi";
export function checkUsingMode(mode: string): mode is UsingMode {
  return mode === "single" || mode === "multi";
}
