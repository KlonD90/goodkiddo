import { runAppChannel } from "../channels";
import { maskSecret, resolveConfig } from "../config";
import { createDb, detectDialect } from "../db";
import { createLogger } from "../logger";
import { startWebServer } from "../server/http";

const log = createLogger("startup");

const config = await resolveConfig();
const db = createDb(config.databaseUrl);
const dialect = detectDialect(config.databaseUrl);

log.info("config loaded", {
	appEntrypoint: config.appEntrypoint,
	aiType: config.aiType,
	aiModelName: config.aiModelName,
	aiApiKey: maskSecret(config.aiApiKey),
	aiBaseUrl: config.aiBaseUrl,
});

if (config.appEntrypoint === "telegram") {
	log.info("telegram config", {
		telegramBotToken: maskSecret(config.telegramBotToken),
		telegramAllowedChatId:
			config.telegramAllowedChatId === ""
				? "<any>"
				: config.telegramAllowedChatId,
	});
}

const webServer = await startWebServer(config, { db, dialect });
const shutdown = async () => {
	await webServer.close();
	await db.close();
};
process.on("SIGINT", () => {
	void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
	void shutdown().finally(() => process.exit(0));
});

await runAppChannel(config, {
	db,
	dialect,
	webShare: {
		access: webServer.access,
		publicBaseUrl: webServer.publicBaseUrl,
	},
});
