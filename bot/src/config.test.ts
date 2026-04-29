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
	"AI_RECURSION_LIMIT",
	"AI_SUB_AGENT_TEMPERATURE",
	"AI_TEMPERATURE",
	"AI_TYPE",
	"APP_ENTRYPOINT",
	"BLOCKED_USER_MESSAGE",
	"CONTEXT_RESERVE_NEXT_TURN_TOKENS",
	"CONTEXT_RESERVE_RECENT_TURN_TOKENS",
	"CONTEXT_RESERVE_SUMMARY_TOKENS",
	"DEFAULT_STATUS_LOCALE",
	"ENABLE_BROWSER_ON_PARENT",
	"ENABLE_TABULAR",
	"ENABLE_EXECUTE",
	"ENABLE_ATTACHMENT_COMPACTION_NOTICE",
	"ENABLE_IMAGE_UNDERSTANDING",
	"ENABLE_PDF_DOCUMENTS",
	"ENABLE_SPREADSHEETS",
	"ENABLE_TOOL_STATUS",
	"ENABLE_VOICE_MESSAGES",
	"MAX_CONTEXT_WINDOW_TOKENS",
	"MINIMAX_API_HOST",
	"MINIMAX_API_KEY",
	"PERMISSIONS_MODE",
	"DATABASE_URL",
	"TELEGRAM_BOT_ALLOWED_CHAT_ID",
	"TELEGRAM_BOT_TOKEN",
	"TIMEZONE",
	"TRANSCRIPTION_API_KEY",
	"TRANSCRIPTION_BASE_URL",
	"TRANSCRIPTION_PROVIDER",
	"USING_MODE",
	"WEB_HOST",
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
					aiTemperature: 1.0,
					aiSubAgentTemperature: 0.4,
					aiType: "openai",
					appEntrypoint: "telegram",
					telegramAllowedChatId: "12345",
					telegramBotToken: "telegram-token",
					usingMode: "multi",
					blockedUserMessage: "Access not configured. Contact the admin.",
					maxContextWindowTokens: 150000,
					contextReserveSummaryTokens: 2000,
					contextReserveRecentTurnTokens: 2000,
					contextReserveNextTurnTokens: 2000,
					permissionsMode: "enforce",
					databaseUrl: "sqlite://./state.db",
					enableExecute: true,
					enablePdfDocuments: true,
					enableSpreadsheets: true,
					enableImageUnderstanding: false,
					enableToolStatus: true,
					enableAttachmentCompactionNotice: true,
					enableBrowserOnParent: false,
					enableTabular: true,
					defaultStatusLocale: "en",
					enableVoiceMessages: false,
					transcriptionProvider: "openrouter",
					transcriptionApiKey: "voice-key",
					transcriptionBaseUrl: "https://voice.example/v1",
					minimaxApiKey: "",
					minimaxApiHost: "https://api.minimax.io",
					webHost: "127.0.0.1",
					webPort: 8083,
					webPublicBaseUrl: "http://localhost:8083",
					timezone: "UTC",
					recursionLimit: 60,
				});
			},
		);
	});

	test("defaults attachment context budget settings when not configured", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.maxContextWindowTokens).toBe(150000);
				expect(config.contextReserveSummaryTokens).toBe(2000);
				expect(config.contextReserveRecentTurnTokens).toBe(2000);
				expect(config.contextReserveNextTurnTokens).toBe(2000);
			},
		);
	});

	test("reads attachment context budget settings from env", async () => {
		await withEnv(
			{
				MAX_CONTEXT_WINDOW_TOKENS: "180000",
				CONTEXT_RESERVE_SUMMARY_TOKENS: "3000",
				CONTEXT_RESERVE_RECENT_TURN_TOKENS: "4000",
				CONTEXT_RESERVE_NEXT_TURN_TOKENS: "5000",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.maxContextWindowTokens).toBe(180000);
				expect(config.contextReserveSummaryTokens).toBe(3000);
				expect(config.contextReserveRecentTurnTokens).toBe(4000);
				expect(config.contextReserveNextTurnTokens).toBe(5000);
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

	test("defaults enableImageUnderstanding to false when not configured", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableImageUnderstanding).toBe(false);
				expect(config.minimaxApiKey).toBe("");
				expect(config.minimaxApiHost).toBe("https://api.minimax.io");
			},
		);
	});

	test("reports missing MINIMAX_API_KEY when ENABLE_IMAGE_UNDERSTANDING=true", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				ENABLE_IMAGE_UNDERSTANDING: "true",
				USING_MODE: "single",
			},
			() => {
				expect(findConfigIssues(readConfigFromEnv())).toContainEqual({
					field: "MINIMAX_API_KEY",
					reason:
						"MINIMAX_API_KEY is required when ENABLE_IMAGE_UNDERSTANDING=true.",
				});
			},
		);
	});

	test("accepts MINIMAX_API_KEY and custom host when image understanding is enabled", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				ENABLE_IMAGE_UNDERSTANDING: "true",
				MINIMAX_API_KEY: "minimax-secret",
				MINIMAX_API_HOST: "https://custom.minimax.test",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableImageUnderstanding).toBe(true);
				expect(config.minimaxApiKey).toBe("minimax-secret");
				expect(config.minimaxApiHost).toBe("https://custom.minimax.test");
				expect(findConfigIssues(config)).toEqual([]);
			},
		);
	});

	test("does not require MINIMAX_API_KEY when ENABLE_IMAGE_UNDERSTANDING is not set", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				USING_MODE: "single",
			},
			() => {
				const issues = findConfigIssues(readConfigFromEnv());
				expect(
					issues.some((issue) => issue.field === "MINIMAX_API_KEY"),
				).toBe(false);
			},
		);
	});

	test("round-trips image understanding env values from a persisted env file", async () => {
		await withEnv({}, async () => {
			const envFilePath = makeTempEnvPath();
			writeFileSync(
				envFilePath,
				[
					'AI_API_KEY="persisted-key"',
					'AI_MODEL_NAME="persisted-model"',
					'AI_TYPE="anthropic"',
					'APP_ENTRYPOINT="cli"',
					'ENABLE_IMAGE_UNDERSTANDING="true"',
					'MINIMAX_API_KEY="persisted-minimax"',
					'MINIMAX_API_HOST="https://custom.minimax.test"',
					'USING_MODE="single"',
				].join("\n"),
				"utf8",
			);

			const config = await resolveConfig({ envFilePath });

			expect(config.enableImageUnderstanding).toBe(true);
			expect(config.minimaxApiKey).toBe("persisted-minimax");
			expect(config.minimaxApiHost).toBe("https://custom.minimax.test");
		});
	});

	test("persists image understanding settings when the wizard fills missing values", async () => {
		await withEnv(
			{
				ENABLE_IMAGE_UNDERSTANDING: "true",
				MINIMAX_API_KEY: "minimax-secret",
				MINIMAX_API_HOST: "https://custom.minimax.test",
			},
			async () => {
				const envFilePath = makeTempEnvPath();
				const textAnswers = ["gpt-4.1-mini", "", "wizard-key"];

				await resolveConfig({
					promptUser: () => textAnswers.shift(),
					selectValue: async (_title, _description, options) =>
						pickOptionValue(options, 0),
					envFilePath,
				});

				const persisted = readFileSync(envFilePath, "utf8");
				expect(persisted).toContain('ENABLE_IMAGE_UNDERSTANDING="true"');
				expect(persisted).toContain('MINIMAX_API_KEY="minimax-secret"');
				expect(persisted).toContain(
					'MINIMAX_API_HOST="https://custom.minimax.test"',
				);
			},
		);
	});

	test("defaults enableAttachmentCompactionNotice to true when not configured", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableAttachmentCompactionNotice).toBe(true);
			},
		);
	});

	test("respects ENABLE_ATTACHMENT_COMPACTION_NOTICE=false env var", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				ENABLE_ATTACHMENT_COMPACTION_NOTICE: "false",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableAttachmentCompactionNotice).toBe(false);
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

	test("reports invalid attachment context budget settings", async () => {
		await withEnv(
			{
				MAX_CONTEXT_WINDOW_TOKENS: "-1",
				CONTEXT_RESERVE_SUMMARY_TOKENS: "NaN",
				CONTEXT_RESERVE_RECENT_TURN_TOKENS: "0",
				CONTEXT_RESERVE_NEXT_TURN_TOKENS: "12.5",
			},
			() => {
				expect(findConfigIssues(readConfigFromEnv())).toEqual(
					expect.arrayContaining([
						{
							field: "MAX_CONTEXT_WINDOW_TOKENS",
							reason: "MAX_CONTEXT_WINDOW_TOKENS must be a positive integer.",
						},
						{
							field: "CONTEXT_RESERVE_SUMMARY_TOKENS",
							reason:
								"CONTEXT_RESERVE_SUMMARY_TOKENS must be a positive integer.",
						},
						{
							field: "CONTEXT_RESERVE_RECENT_TURN_TOKENS",
							reason:
								"CONTEXT_RESERVE_RECENT_TURN_TOKENS must be a positive integer.",
						},
						{
							field: "CONTEXT_RESERVE_NEXT_TURN_TOKENS",
							reason:
								"CONTEXT_RESERVE_NEXT_TURN_TOKENS must be a positive integer.",
						},
					]),
				);
			},
		);
	});

	test("reports attachment budgets whose next-turn reserve consumes the full window", async () => {
		await withEnv(
			{
				MAX_CONTEXT_WINDOW_TOKENS: "2000",
				CONTEXT_RESERVE_SUMMARY_TOKENS: "500",
				CONTEXT_RESERVE_RECENT_TURN_TOKENS: "500",
				CONTEXT_RESERVE_NEXT_TURN_TOKENS: "2000",
			},
			() => {
				expect(findConfigIssues(readConfigFromEnv())).toContainEqual({
					field: "MAX_CONTEXT_WINDOW_TOKENS",
					reason:
						"MAX_CONTEXT_WINDOW_TOKENS must be greater than CONTEXT_RESERVE_NEXT_TURN_TOKENS.",
				});
			},
		);
	});

	test("reports attachment budgets whose reserves exceed the full window", async () => {
		await withEnv(
			{
				MAX_CONTEXT_WINDOW_TOKENS: "3000",
				CONTEXT_RESERVE_SUMMARY_TOKENS: "1000",
				CONTEXT_RESERVE_RECENT_TURN_TOKENS: "1000",
				CONTEXT_RESERVE_NEXT_TURN_TOKENS: "1500",
			},
			() => {
				expect(findConfigIssues(readConfigFromEnv())).toContainEqual({
					field: "MAX_CONTEXT_WINDOW_TOKENS",
					reason:
						"MAX_CONTEXT_WINDOW_TOKENS must be greater than the sum of CONTEXT_RESERVE_SUMMARY_TOKENS, CONTEXT_RESERVE_RECENT_TURN_TOKENS, and CONTEXT_RESERVE_NEXT_TURN_TOKENS.",
				});
			},
		);
	});

	test("reports invalid timezone settings", async () => {
		await withEnv(
			{
				TIMEZONE: "Mars/Base",
			},
			() => {
				expect(findConfigIssues(readConfigFromEnv())).toContainEqual({
					field: "TIMEZONE",
					reason:
						'TIMEZONE must be a valid IANA timezone, for example "UTC" or "America/New_York".',
				});
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

	test("allows empty AI_API_KEY when AI_BASE_URL points to a custom endpoint", async () => {
		await withEnv(
			{
				AI_BASE_URL: "http://127.0.0.1:11434/v1",
				AI_MODEL_NAME: "local-model",
				AI_TYPE: "openai",
				USING_MODE: "single",
			},
			() => {
				expect(findConfigIssues(readConfigFromEnv())).toEqual([]);
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
			expect(issues.find((issue) => issue.field === "AI_API_KEY")?.reason).toBe(
				"AI_API_KEY is required unless AI_BASE_URL points to a local/custom endpoint.",
			);
		});
	});

	test("requires AI_API_KEY for openrouter even with a custom endpoint", async () => {
		await withEnv(
			{
				AI_BASE_URL: "http://router.local/v1",
				AI_MODEL_NAME: "router-model",
				AI_TYPE: "openrouter",
				USING_MODE: "single",
			},
			() => {
				expect(findConfigIssues(readConfigFromEnv())).toContainEqual({
					field: "AI_API_KEY",
					reason: "AI_API_KEY is required for AI_TYPE=openrouter.",
				});
			},
		);
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
					"https://openai.example",
					"wizard-key",
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
					aiTemperature: 1.0,
					aiSubAgentTemperature: 0.4,
					aiType: "openai",
					appEntrypoint: "cli",
					telegramAllowedChatId: "",
					telegramBotToken: "",
					usingMode: "single",
					blockedUserMessage: "Access not configured. Contact the admin.",
					maxContextWindowTokens: 150000,
					contextReserveSummaryTokens: 2000,
					contextReserveRecentTurnTokens: 2000,
					contextReserveNextTurnTokens: 2000,
					permissionsMode: "enforce",
					databaseUrl: "sqlite://./state.db",
					enableExecute: true,
					enablePdfDocuments: true,
					enableSpreadsheets: true,
					enableImageUnderstanding: false,
					enableToolStatus: true,
					enableAttachmentCompactionNotice: true,
					enableBrowserOnParent: false,
					enableTabular: true,
					defaultStatusLocale: "en",
					enableVoiceMessages: true,
					transcriptionProvider: "openai",
					transcriptionApiKey: "wizard-key",
					transcriptionBaseUrl: "",
					minimaxApiKey: "",
					minimaxApiHost: "https://api.minimax.io",
					webHost: "127.0.0.1",
					webPort: 8083,
					webPublicBaseUrl: "http://localhost:8083",
					timezone: "UTC",
					recursionLimit: 60,
				});
			},
		);
	});

	test("collects telegram settings when telegram entrypoint is selected", async () => {
		await withEnv({}, async () => {
			const textAnswers = [
				"gpt-4.1",
				"",
				"selector-key",
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
				aiTemperature: 1.0,
				aiSubAgentTemperature: 0.4,
				aiType: "openai",
				appEntrypoint: "telegram",
				telegramAllowedChatId: "-1001234567890",
				telegramBotToken: "telegram-token",
				usingMode: "multi",
				blockedUserMessage: "Access not configured. Contact the admin.",
				maxContextWindowTokens: 150000,
				contextReserveSummaryTokens: 2000,
				contextReserveRecentTurnTokens: 2000,
				contextReserveNextTurnTokens: 2000,
				permissionsMode: "enforce",
				databaseUrl: "sqlite://./state.db",
				enableExecute: true,
				enablePdfDocuments: true,
				enableSpreadsheets: true,
				enableImageUnderstanding: false,
				enableToolStatus: true,
				enableAttachmentCompactionNotice: true,
				enableBrowserOnParent: false,
				enableTabular: true,
				defaultStatusLocale: "en",
				enableVoiceMessages: true,
				transcriptionProvider: "openai",
				transcriptionApiKey: "selector-key",
				transcriptionBaseUrl: "",
				minimaxApiKey: "",
				minimaxApiHost: "https://api.minimax.io",
				webHost: "127.0.0.1",
				webPort: 8083,
				webPublicBaseUrl: "http://localhost:8083",
				timezone: "UTC",
				recursionLimit: 60,
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
			const textAnswers = ["gpt-4.1-mini", "", "wizard-key"];

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
				'MAX_CONTEXT_WINDOW_TOKENS="150000"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'CONTEXT_RESERVE_SUMMARY_TOKENS="2000"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'CONTEXT_RESERVE_RECENT_TURN_TOKENS="2000"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'CONTEXT_RESERVE_NEXT_TURN_TOKENS="2000"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'ENABLE_VOICE_MESSAGES="true"',
			);
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'ENABLE_ATTACHMENT_COMPACTION_NOTICE="true"',
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
			const initialAnswers = ["gpt-4.1-mini", "", "wizard-key"];

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
			expect(config.maxContextWindowTokens).toBe(150000);
			expect(config.contextReserveSummaryTokens).toBe(2000);
			expect(config.contextReserveRecentTurnTokens).toBe(2000);
			expect(config.contextReserveNextTurnTokens).toBe(2000);
			expect(config.transcriptionProvider).toBe("openai");
			expect(config.transcriptionApiKey).toBe("");
			expect(config.usingMode).toBe("single");
			expect(readFileSync(envFilePath, "utf8")).toContain(
				'CUSTOM_FLAG="keep-me"',
			);
		});
	});

	test("wizard allows empty AI_API_KEY for a local custom endpoint", async () => {
		await withEnv(
			{
				AI_TYPE: "openai",
			},
			async () => {
				const textAnswers = [
					"local-model",
					"http://127.0.0.1:11434/v1",
					"",
				];

				const config = await resolveConfig({
					promptUser: () => textAnswers.shift(),
					selectValue: async (_title, _description, options) =>
						pickOptionValue(options, 0),
					envFilePath: makeTempEnvPath(),
				});

				expect(config.aiBaseUrl).toBe("http://127.0.0.1:11434/v1");
				expect(config.aiApiKey).toBe("");
			},
		);
	});

test("defaults enableBrowserOnParent to false when not configured", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableBrowserOnParent).toBe(false);
			},
		);
	});

	test("respects ENABLE_BROWSER_ON_PARENT=true env var", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				ENABLE_BROWSER_ON_PARENT: "true",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableBrowserOnParent).toBe(true);
			},
		);
	});

	test("respects ENABLE_BROWSER_ON_PARENT=false env var", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				ENABLE_BROWSER_ON_PARENT: "false",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableBrowserOnParent).toBe(false);
			},
		);
	});

	test("defaults enableTabular to true when not configured", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableTabular).toBe(true);
			},
		);
	});

	test("respects ENABLE_TABULAR=false env var", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				ENABLE_TABULAR: "false",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableTabular).toBe(false);
			},
		);
	});

	test("respects ENABLE_TABULAR=true env var", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				ENABLE_TABULAR: "true",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.enableTabular).toBe(true);
			},
		);
	});

	test("defaults recursionLimit to 60 when not configured", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.recursionLimit).toBe(60);
			},
		);
	});

	test("respects AI_RECURSION_LIMIT env var", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				AI_RECURSION_LIMIT: "100",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.recursionLimit).toBe(100);
			},
		);
	});

	test("defaults agent temperatures when not configured", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "anthropic",
				AI_MODEL_NAME: "claude-3-5-sonnet",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.aiTemperature).toBe(1.0);
				expect(config.aiSubAgentTemperature).toBe(0.4);
			},
		);
	});

	test("reads agent temperatures from env", async () => {
		await withEnv(
			{
				AI_API_KEY: "test-key",
				AI_TYPE: "openai",
				AI_MODEL_NAME: "gpt-4.1-mini",
				AI_TEMPERATURE: "1",
				AI_SUB_AGENT_TEMPERATURE: "0.25",
				USING_MODE: "single",
			},
			() => {
				const config = readConfigFromEnv();
				expect(config.aiTemperature).toBe(1);
				expect(config.aiSubAgentTemperature).toBe(0.25);
			},
		);
	});

	test("reports invalid agent temperatures", async () => {
		await withEnv(
			{
				AI_TEMPERATURE: "1.5",
				AI_SUB_AGENT_TEMPERATURE: "cold",
			},
			() => {
				expect(findConfigIssues(readConfigFromEnv())).toEqual(
					expect.arrayContaining([
						{
							field: "AI_TEMPERATURE",
							reason: "AI_TEMPERATURE must be a number between 0 and 1.",
						},
						{
							field: "AI_SUB_AGENT_TEMPERATURE",
							reason:
								"AI_SUB_AGENT_TEMPERATURE must be a number between 0 and 1.",
						},
					]),
				);
			},
		);
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
					'MAX_CONTEXT_WINDOW_TOKENS="170000"',
					'CONTEXT_RESERVE_SUMMARY_TOKENS="2100"',
					'CONTEXT_RESERVE_RECENT_TURN_TOKENS="2200"',
					'CONTEXT_RESERVE_NEXT_TURN_TOKENS="2300"',
					'ENABLE_ATTACHMENT_COMPACTION_NOTICE="false"',
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
			expect(config.enableAttachmentCompactionNotice).toBe(false);
			expect(config.maxContextWindowTokens).toBe(170000);
			expect(config.contextReserveSummaryTokens).toBe(2100);
			expect(config.contextReserveRecentTurnTokens).toBe(2200);
			expect(config.contextReserveNextTurnTokens).toBe(2300);
			expect(config.transcriptionProvider).toBe("openrouter");
			expect(config.transcriptionApiKey).toBe("persisted-voice-key");
			expect(config.transcriptionBaseUrl).toBe("https://voice.example/v1");
			expect(process.env.AI_API_KEY).toBeUndefined();
			expect(process.env.AI_MODEL_NAME).toBeUndefined();
			expect(process.env.AI_TYPE).toBeUndefined();
		});
	});
});
