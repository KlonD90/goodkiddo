import type { AppConfig } from "../../config";
import { createMinimaxImageUnderstanding } from "./minimax_provider";
import type { ImageUnderstandingProvider } from "./types";

export function createImageUnderstandingProvider(
	config: AppConfig,
): ImageUnderstandingProvider | null {
	if (!config.enableImageUnderstanding) return null;
	if (config.minimaxApiKey === "") return null;

	return createMinimaxImageUnderstanding({
		apiKey: config.minimaxApiKey,
		apiHost: config.minimaxApiHost,
	});
}
