import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	"ENABLE_EXECUTE",
	"ENABLE_PDF_DOCUMENTS",
	"ENABLE_SPREADSHEETS",
	"ENABLE_VOICE_MESSAGES",
	"PERMISSIONS_MODE",
	"DATABASE_URL",
	"TELEGRAM_BOT_ALLOWED_CHAT_ID",
	"TELEGRAM_BOT_TOKEN",
	"TIMEZONE",
	"TRANSCRIPTION_API_KEY",
	"TRANSCRIPTION_BASE_URL",
	"TRANSCRIPTION_PROVIDER",
	"USING_MODE",
	"WEB_PORT",
	"WEB_PUBLIC_BASE_URL",
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
				ENABLE_VOICE_MESSAGES: "false",
				TELEGRAM_BOT_ALLOWED_CHAT_ID: "12345",
				TELEGRAM_BOT_TOKEN: "telegram-token",
				TRANSCRIPTION_API_KEY: "voice-key",
				TRANSCRIPTION_BASE_URL: "https://voice.example/v1",
				TRANSCRIPTION_PROVIDER: "openrouter",
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
					databaseUrl: "sqlite://./state.db",
					enableExecute: true,
					enablePdfDocuments: true,
					enableSpreadsheets: true,
					enableVoiceMessages: false,
					transcriptionProvider: "openrouter",
					transcriptionApiKey: "voice-key",
					transcriptionBaseUrl: "https://voice.example/v1",
					webPort: 8083,
					webPublicBaseUrl: "http://localhost:8083",
					timezone: "UTC",
				});
			},
		);
	});

	test("defaults voice transcription settings when not configured", async () => {
		await withEnv(
			{
				AI_API_KEY: "openrouter-key",
				AI_TYPE: "openrouter",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableVoiceMessages).toBe(true);
				expect(config.transcriptionProvider).toBe("openrouter");
				expect(config.transcriptionApiKey).toBe("openrouter-key");
			},
		);
	});

	test("defaults enablePdfDocuments to true when not configured", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enablePdfDocuments).toBe(true);
			},
		);
	});

	test("respects ENABLE_PDF_DOCUMENTS=false env var", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				ENABLE_PDF_DOCUMENTS: "false",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enablePdfDocuments).toBe(false);
			},
		);
	});

	test("defaults enableSpreadsheets to true when not configured", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableSpreadsheets).toBe(true);
			},
		);
	});

	test("respects ENABLE_SPREADSHEETS=false env var", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				ENABLE_SPREADSHEETS: "false",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableSpreadsheets).toBe(false);
			},
		);
	});

	test("defaults the transcription provider to openai for non-openrouter models", async () => {
		await withEnv(
			{
				AI_TYPE: "anthropic",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.transcriptionProvider).toBe("openai");
				expect(config.transcriptionApiKey).toBe("");
			},
		);
	});

	test("reports an invalid transcription provider value", async () => {
		await withEnv(
			{
				TRANSCRIPTION_PROVIDER: "bogus",
			},
			() => {
				expect(findConfigIssues(readConfigFromEnv())).toContainEqual({
					field: "TRANSCRIPTION_PROVIDER",
					reason:
						'Invalid TRANSCRIPTION_PROVIDER "bogus". Supported values: openai, openrouter',
				});
			},
		);
	});

	test("informs about missing transcription key when Telegram voice cannot reuse AI_API_KEY", async () => {
		await withEnv(
			{
				AI_API_KEY: "anthropic-key",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				AI_TYPE: "anthropic",
				APP_ENTRYPOINT: "telegram",
				TELEGRAM_BOT_TOKEN: "telegram-token",
				USING_MODE: "single",
			},
			() => {
				expect(findConfigIssues(readConfigFromEnv())).toContainEqual({
					field: "TRANSCRIPTION_API_KEY",
					reason:
						"TRANSCRIPTION_API_KEY is not set. Voice transcription will use NoOpTranscriber (transcription capability unavailable).",
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

	test("ignores legacy STATE_DB_PATH and uses DATABASE_URL only", () => {
		const previousStateDbPath = process.env.STATE_DB_PATH;
		delete process.env.DATABASE_URL;
		process.env.STATE_DB_PATH = "./legacy.db";

		try {
			expect(readConfigFromEnv().databaseUrl).toBe("sqlite://./state.db");
		} finally {
			if (previousStateDbPath === undefined) {
				delete process.env.STATE_DB_PATH;
			} else {
				process.env.STATE_DB_PATH = previousStateDbPath;
			}
		}
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
					databaseUrl: "sqlite://./state.db",
					enableExecute: true,
					enablePdfDocuments: true,
					enableSpreadsheets: true,
					enableVoiceMessages: true,
					transcriptionProvider: "openai",
					transcriptionApiKey: "wizard-key",
					transcriptionBaseUrl: "",
					webPort: 8083,
					webPublicBaseUrl: "http://localhost:8083",
					timezone: "UTC",
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
				databaseUrl: "sqlite://./state.db",
				enableExecute: true,
				enablePdfDocuments: true,
				enableSpreadsheets: true,
				enableVoiceMessages: true,
				transcriptionProvider: "openai",
				transcriptionApiKey: "selector-key",
				transcriptionBaseUrl: "",
				webPort: 8083,
				webPublicBaseUrl: "http://localhost:8083",
				timezone: "UTC",
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
				'ENABLE_VOICE_MESSAGES="true"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'TRANSCRIPTION_PROVIDER="openai"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'TRANSCRIPTION_API_KEY=""',
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
			expect(config.enableVoiceMessages).toBe(true);
			expect(config.transcriptionProvider).toBe("openai");
			expect(config.transcriptionApiKey).toBe("");
			expect(config.usingMode).toBe("single");
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'CUSTOM_FLAG="keep-me"',
			);
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
					'ENABLE_VOICE_MESSAGES="false"',
					'TRANSCRIPTION_API_KEY="persisted-voice-key"',
					'TRANSCRIPTION_BASE_URL="https://voice.example/v1"',
					'TRANSCRIPTION_PROVIDER="openrouter"',
					'USING_MODE="single"',
				].join("\n"),
				"utf8",
			);

			const config = await resolveConfig({ envFilePath });

			expect(config.aiApiKey).toBe("persisted-key");
			expect(config.enableVoiceMessages).toBe(false);
			expect(config.transcriptionProvider).toBe("openrouter");
			expect(config.transcriptionApiKey).toBe("persisted-voice-key");
			expect(config.transcriptionBaseUrl).toBe("https://voice.example/v1");
			expect(process.env.AI_API_KEY).toBeUndefined();
			expect(process.env.AI_MODEL_NAME).toBeUndefined();
			expect(process.env.AI_TYPE).toBeUndefined();
		});
	});
});
