import type { SupportedAiTypes } from "../types";
import { ChatOpenRouter } from "@langchain/openrouter";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI, ChatOpenAIFields } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export const modelChooser = (
  aiType: SupportedAiTypes,
  modelName: string,
  apiKey: string = "",
  baseUrl: string = "",
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
      });
    case "openai":
      const params: ChatOpenAIFields = {
        model: modelName,
        apiKey: apiKey,
      };
      if (baseUrl !== "") {
        params.configuration = { baseURL: baseUrl };
      }
      return new ChatOpenAI(params);
    case "openrouter":
      if (apiKey === "") {
        throw new Error("OpenRouter API key is required");
      }
      return new ChatOpenRouter({
        model: modelName,
        apiKey: apiKey,
        baseURL: baseUrl === "" ? undefined : baseUrl,
      });
    default:
      throw new Error(`Unsupported AI type: ${aiType}`);
  }
};
