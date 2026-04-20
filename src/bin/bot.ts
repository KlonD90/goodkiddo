import { runAppChannel } from "../channels";
import { maskSecret, resolveConfig } from "../config";
import { createDb, detectDialect } from "../db";
import { startWebServer } from "../server/http";

const config = await resolveConfig();
const db = createDb(config.databaseUrl);
const dialect = detectDialect(config.databaseUrl);

console.log("APP_ENTRYPOINT:", config.appEntrypoint);
console.log("AI_TYPE:", config.aiType);
console.log("AI_MODEL_NAME:", config.aiModelName);
console.log("AI_API_KEY:", maskSecret(config.aiApiKey));
console.log("AI_BASE_URL:", config.aiBaseUrl);

if (config.appEntrypoint === "telegram") {
	console.log("TELEGRAM_BOT_TOKEN:", maskSecret(config.telegramBotToken));
	console.log(
		"TELEGRAM_BOT_ALLOWED_CHAT_ID:",
		config.telegramAllowedChatId === ""
			? "<any>"
			: config.telegramAllowedChatId,
	);
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
