import { describe, expect, test } from "bun:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOpenRouter } from "@langchain/openrouter";
import { modelChooser } from "./model_chooser";

describe("modelChooser", () => {
	test("creates an anthropic model with the provided base URL", () => {
		const model = modelChooser(
			"anthropic",
			"claude-3-5-sonnet",
			"anthropic-key",
			"https://anthropic.example",
		) as ChatAnthropic & { apiUrl?: string; apiKey?: string; model?: string };

		expect(model).toBeInstanceOf(ChatAnthropic);
		expect(model.model).toBe("claude-3-5-sonnet");
		expect(model.apiKey).toBe("anthropic-key");
		expect(model.apiUrl).toBe("https://anthropic.example");
	});

	test("creates an openai model with custom configuration when base URL is provided", () => {
		const model = modelChooser(
			"openai",
			"gpt-4.1",
			"openai-key",
			"https://openai.example",
		) as ChatOpenAI & {
			apiKey?: string;
			model?: string;
			fields?: { configuration?: { baseURL?: string } };
		};

		expect(model).toBeInstanceOf(ChatOpenAI);
		expect(model.model).toBe("gpt-4.1");
		expect(model.apiKey).toBe("openai-key");
		expect(model.fields?.configuration?.baseURL).toBe("https://openai.example");
	});

	test("creates an openai model without configuration override when base URL is empty", () => {
		const model = modelChooser(
			"openai",
			"gpt-4.1-mini",
			"openai-key",
		) as ChatOpenAI & {
			fields?: { configuration?: { baseURL?: string } };
		};

		expect(model.fields?.configuration).toBeUndefined();
	});

	test("creates an openrouter model with the provided API key and base URL", () => {
		const model = modelChooser(
			"openrouter",
			"openai/gpt-4.1",
			"openrouter-key",
			"https://openrouter.example",
		) as ChatOpenRouter & {
			apiKey?: string;
			baseURL?: string;
			model?: string;
		};

		expect(model).toBeInstanceOf(ChatOpenRouter);
		expect(model.model).toBe("openai/gpt-4.1");
		expect(model.apiKey).toBe("openrouter-key");
		expect(model.baseURL).toBe("https://openrouter.example");
	});

	test("throws for openrouter when no API key is provided", () => {
		const previousApiKey = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "env-openrouter-key";

		try {
			expect(() => modelChooser("openrouter", "openai/gpt-4.1")).toThrow(
				/OpenRouter API key is required/i,
			);
		} finally {
			if (previousApiKey === undefined) {
				delete process.env.OPENROUTER_API_KEY;
			} else {
				process.env.OPENROUTER_API_KEY = previousApiKey;
			}
		}
	});

	test("throws for unsupported AI types", () => {
		expect(() =>
			modelChooser("unsupported" as never, "some-model", "some-key"),
		).toThrow(/Unsupported AI type: unsupported/);
	});
});
