import { runAppChannel } from "../channels";
import { maskSecret, resolveConfig } from "../config";
import { createDb, detectDialect } from "../db";
import { migrateDatabase } from "../db/migrate";
import { createLogger } from "../logger";
import { startWebServer } from "../server/http";

export interface BotStartupDependencies {
	createDb: typeof createDb;
	createLogger: typeof createLogger;
	detectDialect: typeof detectDialect;
	maskSecret: typeof maskSecret;
	migrateDatabase: typeof migrateDatabase;
	onSignal: typeof process.on;
	resolveConfig: typeof resolveConfig;
	runAppChannel: typeof runAppChannel;
	startWebServer: typeof startWebServer;
}

const defaultDependencies: BotStartupDependencies = {
	createDb,
	createLogger,
	detectDialect,
	maskSecret,
	migrateDatabase,
	onSignal: process.on.bind(process),
	resolveConfig,
	runAppChannel,
	startWebServer,
};

export const startBot = async (
	dependencies: BotStartupDependencies = defaultDependencies,
): Promise<void> => {
	const log = dependencies.createLogger("startup");

	const config = await dependencies.resolveConfig();
	log.info("running database migrations");
	await dependencies.migrateDatabase({ databaseUrl: config.databaseUrl });
	const db = dependencies.createDb(config.databaseUrl);
	const dialect = dependencies.detectDialect(config.databaseUrl);

	log.info("config loaded", {
		appEntrypoint: config.appEntrypoint,
		aiType: config.aiType,
		aiModelName: config.aiModelName,
		aiApiKey: dependencies.maskSecret(config.aiApiKey),
		aiBaseUrl: config.aiBaseUrl,
	});

	if (config.appEntrypoint === "telegram") {
		log.info("telegram config", {
			telegramBotToken: dependencies.maskSecret(config.telegramBotToken),
			telegramAllowedChatId:
				config.telegramAllowedChatId === ""
					? "<any>"
					: config.telegramAllowedChatId,
		});
	}

	const webServer = await dependencies.startWebServer(config, { db, dialect });
	const shutdown = async () => {
		await webServer.close();
		await db.close();
	};
	dependencies.onSignal("SIGINT", () => {
		void shutdown().finally(() => process.exit(0));
	});
	dependencies.onSignal("SIGTERM", () => {
		void shutdown().finally(() => process.exit(0));
	});

	await dependencies.runAppChannel(config, {
		db,
		dialect,
		webShare: {
			access: webServer.access,
			publicBaseUrl: webServer.publicBaseUrl,
		},
	});
};

if (import.meta.main) {
	await startBot();
}
