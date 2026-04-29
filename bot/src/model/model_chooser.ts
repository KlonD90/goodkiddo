import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import { ChatOpenRouter } from "@langchain/openrouter";
import type { SupportedAiTypes } from "../types";

export const modelChooser = (
	aiType: SupportedAiTypes,
	modelName: string,
	apiKey: string = "",
	baseUrl: string = "",
	options: { temperature?: number } = {},
): BaseChatModel => {
	if (modelName === "") {
		throw new Error(
			"Model name is required, you could set it in the .env file",
		);
	}
	switch (aiType) {
		case "anthropic":
			return new ChatAnthropic({
				model: modelName,
				apiKey: apiKey,
				anthropicApiUrl: baseUrl === "" ? undefined : baseUrl,
				temperature: options.temperature,
			});
		case "openai": {
			const params: ChatOpenAIFields = {
				model: modelName,
				apiKey: apiKey,
				temperature: options.temperature,
			};
			if (baseUrl !== "") {
				params.configuration = { baseURL: baseUrl };
			}
			return new ChatOpenAI(params);
		}
		case "openrouter":
			if (apiKey === "") {
				throw new Error("OpenRouter API key is required");
			}
			return new ChatOpenRouter({
				model: modelName,
				apiKey: apiKey,
				baseURL: baseUrl === "" ? undefined : baseUrl,
				temperature: options.temperature,
			});
		default:
			throw new Error(`Unsupported AI type: ${aiType}`);
	}
};
