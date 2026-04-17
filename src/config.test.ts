import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
	"BLOCKED_USER_MESSAGE",
	"PERMISSIONS_MODE",
	"STATE_DB_PATH",
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

const makeTempEnvPath = (): string =>
	join(mkdtempSync(join(tmpdir(), "top-fedder-config-")), ".env");

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
					blockedUserMessage: "Access not configured. Contact the admin.",
					permissionsMode: "enforce",
					stateDbPath: "./state.db",
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
					envFilePath: makeTempEnvPath(),
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
					blockedUserMessage: "Access not configured. Contact the admin.",
					permissionsMode: "enforce",
					stateDbPath: "./state.db",
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
				envFilePath: makeTempEnvPath(),
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
				blockedUserMessage: "Access not configured. Contact the admin.",
				permissionsMode: "enforce",
				stateDbPath: "./state.db",
			});
		});
	});

	test("masks secrets in logs", () => {
		expect(maskSecret("")).toBe("<empty>");
		expect(maskSecret("secret-token")).toBe("sec***ken");
	});

	test("persists wizard answers into the env file", async () => {
		await withEnv({}, async () => {
			const envFilePath = makeTempEnvPath();
			const textAnswers = ["gpt-4.1-mini", "wizard-key", ""];

			await resolveConfig({
				promptUser: () => textAnswers.shift(),
				selectValue: async (_title, _description, options) =>
					pickOptionValue(options, 0),
				envFilePath,
			});

			expect(readFileSync(envFilePath, "utf8")).toContain(
				'AI_API_KEY="wizard-key"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'AI_MODEL_NAME="gpt-4.1-mini"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'AI_TYPE="anthropic"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'APP_ENTRYPOINT="cli"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'USING_MODE="single"',
			);
		});
	});

	test("reuses persisted env values without prompting again", async () => {
		await withEnv({}, async () => {
			const envFilePath = makeTempEnvPath();
			const initialAnswers = ["gpt-4.1-mini", "wizard-key", ""];

			writeFileSync(envFilePath, 'CUSTOM_FLAG="keep-me"\n', "utf8");

			await resolveConfig({
				promptUser: () => initialAnswers.shift(),
				selectValue: async (_title, _description, options) =>
					pickOptionValue(options, 0),
				envFilePath,
			});

			let promptCalls = 0;
			const config = await resolveConfig({
				promptUser: () => {
					promptCalls += 1;
					return "should-not-be-used";
				},
				selectValue: async () => {
					throw new Error("selector should not run when env file is complete");
				},
				envFilePath,
			});

			expect(promptCalls).toBe(0);
			expect(config.aiApiKey).toBe("wizard-key");
			expect(config.aiModelName).toBe("gpt-4.1-mini");
			expect(config.aiType).toBe("anthropic");
			expect(config.appEntrypoint).toBe("cli");
			expect(config.usingMode).toBe("single");
			expect(readFileSync(envFilePath, "utf8")).toContain('CUSTOM_FLAG="keep-me"');
		});
	});

	test("does not write persisted values back into process.env", async () => {
		await withEnv({}, async () => {
			const envFilePath = makeTempEnvPath();
			writeFileSync(
				envFilePath,
				[
					'AI_API_KEY="persisted-key"',
					'AI_MODEL_NAME="persisted-model"',
					'AI_TYPE="openai"',
					'APP_ENTRYPOINT="cli"',
					'USING_MODE="single"',
				].join("\n"),
				"utf8",
			);

			const config = await resolveConfig({ envFilePath });

			expect(config.aiApiKey).toBe("persisted-key");
			expect(process.env.AI_API_KEY).toBeUndefined();
			expect(process.env.AI_MODEL_NAME).toBeUndefined();
			expect(process.env.AI_TYPE).toBeUndefined();
		});
	});
});
