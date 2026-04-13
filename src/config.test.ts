import { describe, expect, test } from "bun:test";
import {
	type AppConfig,
	findConfigIssues,
	maskSecret,
	readConfigFromEnv,
	resolveConfig,
} from "./config";

const CONFIG_KEYS = [
	"AI_API_KEY",
	"AI_BASE_URL",
	"AI_MODEL_NAME",
	"AI_TYPE",
	"APP_ENTRYPOINT",
	"TELEGRAM_BOT_ALLOWED_CHAT_ID",
	"TELEGRAM_BOT_TOKEN",
	"USING_MODE",
] as const;

const withEnv = async (
	values: Partial<Record<(typeof CONFIG_KEYS)[number], string | undefined>>,
	callback: () => Promise<void> | void,
): Promise<void> => {
	const previousValues = Object.fromEntries(
		CONFIG_KEYS.map((key) => [key, process.env[key]]),
	) as Record<(typeof CONFIG_KEYS)[number], string | undefined>;

	for (const key of CONFIG_KEYS) {
		const nextValue = values[key];
		if (nextValue === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = nextValue;
		}
	}

	try {
		await callback();
	} finally {
		for (const key of CONFIG_KEYS) {
			const previous = previousValues[key];
			if (previous === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previous;
			}
		}
	}
};

const pickOptionValue = <TValue extends string>(
	options: readonly { value: TValue }[],
	index: number,
): TValue => {
	const option = options[index];
	if (option === undefined) {
		throw new Error(`missing option at index ${index}`);
	}

	return option.value;
};

describe("config", () => {
	test("reads complete config from env", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_BASE_URL: "https://example.test",
				AI_MODEL_NAME: "gpt-4.1-mini",
				AI_TYPE: "openai",
				APP_ENTRYPOINT: "telegram",
				TELEGRAM_BOT_ALLOWED_CHAT_ID: "12345",
				TELEGRAM_BOT_TOKEN: "telegram-token",
				USING_MODE: "multi",
			},
			() => {
				expect(readConfigFromEnv()).toEqual({
					aiApiKey: "test-key",
					aiBaseUrl: "https://example.test",
					aiModelName: "gpt-4.1-mini",
					aiType: "openai",
					appEntrypoint: "telegram",
					telegramAllowedChatId: "12345",
					telegramBotToken: "telegram-token",
					usingMode: "multi",
				});
			},
		);
	});

	test("reports missing required fields", async () => {
		await withEnv({}, () => {
			const issues = findConfigIssues(readConfigFromEnv());

			expect(issues.map((issue) => issue.field)).toEqual([
				"AI_MODEL_NAME",
				"AI_API_KEY",
				"USING_MODE",
			]);
		});
	});

	test("requires telegram token when telegram entrypoint is selected", async () => {
		await withEnv(
			{
				AI_API_KEY: "openai-key",
				AI_MODEL_NAME: "gpt-4.1-mini",
				AI_TYPE: "openai",
				APP_ENTRYPOINT: "telegram",
				USING_MODE: "single",
			},
			() => {
				const issues = findConfigIssues(readConfigFromEnv());
				expect(issues.map((issue) => issue.field)).toEqual([
					"TELEGRAM_BOT_TOKEN",
				]);
			},
		);
	});

	test("fills missing values through the wizard", async () => {
		await withEnv(
			{
				AI_TYPE: "openai",
			},
			async () => {
				const textAnswers = [
					"gpt-4.1-mini",
					"wizard-key",
					"https://openai.example",
				];

				const config = await resolveConfig({
					promptUser: () => textAnswers.shift(),
					selectValue: async (_title, _description, options) =>
						pickOptionValue(options, 0),
				});

				expect(config).toEqual<AppConfig>({
					aiApiKey: "wizard-key",
					aiBaseUrl: "https://openai.example",
					aiModelName: "gpt-4.1-mini",
					aiType: "openai",
					appEntrypoint: "cli",
					telegramAllowedChatId: "",
					telegramBotToken: "",
					usingMode: "single",
				});
			},
		);
	});

	test("collects telegram settings when telegram entrypoint is selected", async () => {
		await withEnv({}, async () => {
			const textAnswers = [
				"gpt-4.1",
				"selector-key",
				"",
				"telegram-token",
				"-1001234567890",
			];
			let selectorCall = 0;

			const config = await resolveConfig({
				promptUser: () => textAnswers.shift(),
				selectValue: async (_title, _description, options) => {
					selectorCall += 1;

					if (selectorCall === 1) {
						return pickOptionValue(options, 1);
					}

					if (selectorCall === 2) {
						return pickOptionValue(options, 1);
					}

					return pickOptionValue(options, 1);
				},
			});

			expect(config).toEqual<AppConfig>({
				aiApiKey: "selector-key",
				aiBaseUrl: "",
				aiModelName: "gpt-4.1",
				aiType: "openai",
				appEntrypoint: "telegram",
				telegramAllowedChatId: "-1001234567890",
				telegramBotToken: "telegram-token",
				usingMode: "multi",
			});
		});
	});

	test("masks secrets in logs", () => {
		expect(maskSecret("")).toBe("<empty>");
		expect(maskSecret("secret-token")).toBe("sec***ken");
	});
});
