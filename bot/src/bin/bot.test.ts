import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config";
import type { BotStartupDependencies } from "./bot";
import { startBot } from "./bot";

const config: AppConfig = {
	aiApiKey: "test-key",
	aiBaseUrl: "",
	aiModelName: "test-model",
	aiSubAgentTemperature: 0.4,
	aiTemperature: 1,
	aiType: "anthropic",
	appEntrypoint: "cli",
	blockedUserMessage: "blocked",
	contextReserveNextTurnTokens: 2000,
	contextReserveRecentTurnTokens: 2000,
	contextReserveSummaryTokens: 2000,
	databaseUrl: "sqlite://./state.db",
	defaultStatusLocale: "en",
	enableAttachmentCompactionNotice: true,
	enableBrowserOnParent: false,
	enableExecute: true,
	enableImageUnderstanding: false,
	enablePdfDocuments: true,
	enableSpreadsheets: true,
	enableTabular: true,
	enableToolStatus: true,
	enableVoiceMessages: true,
	maxContextWindowTokens: 150000,
	minimaxApiHost: "https://api.minimax.io",
	minimaxApiKey: "",
	permissionsMode: "enforce",
	recursionLimit: 60,
	telegramAllowedChatId: "",
	telegramBotToken: "",
	timezone: "UTC",
	transcriptionApiKey: "",
	transcriptionBaseUrl: "",
	transcriptionProvider: "openai",
	usingMode: "single",
	webHost: "127.0.0.1",
	webPort: 8083,
	webPublicBaseUrl: "http://localhost:8083",
};

describe("bot startup", () => {
	test("runs migrations before opening the application database", async () => {
		const calls: string[] = [];
		const db = {
			close: async () => {
				calls.push("closeDb");
			},
		} as ReturnType<BotStartupDependencies["createDb"]>;
		const logger = {
			debug: () => undefined,
			error: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			child: () => logger,
		};

		await startBot({
			createDb: (databaseUrl) => {
				expect(databaseUrl).toBe(config.databaseUrl);
				calls.push("createDb");
				return db;
			},
			createLogger: () => logger,
			detectDialect: (databaseUrl) => {
				expect(databaseUrl).toBe(config.databaseUrl);
				calls.push("detectDialect");
				return "sqlite";
			},
			maskSecret: (value) => value,
			migrateDatabase: async (options) => {
				expect(options?.databaseUrl).toBe(config.databaseUrl);
				calls.push("migrateDatabase");
			},
			onSignal: () => process,
			resolveConfig: async () => {
				calls.push("resolveConfig");
				return config;
			},
			runAppChannel: async () => {
				calls.push("runAppChannel");
			},
			startWebServer: async () => {
				calls.push("startWebServer");
				return {
					access: {},
					close: async () => {
						calls.push("closeWebServer");
					},
					publicBaseUrl: config.webPublicBaseUrl,
					server: {},
					sweepTimer: undefined,
				} as Awaited<ReturnType<BotStartupDependencies["startWebServer"]>>;
			},
		});

		expect(calls).toEqual([
			"resolveConfig",
			"migrateDatabase",
			"createDb",
			"detectDialect",
			"startWebServer",
			"runAppChannel",
		]);
	});
});
