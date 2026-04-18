import { runAppChannel } from "../channels";
import { maskSecret, resolveConfig } from "../config";
import { startWebServer } from "../server/http";

const config = await resolveConfig();

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

const webServer = await startWebServer(config);
const shutdown = async () => {
	await webServer.close();
};
process.on("SIGINT", () => {
	void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
	void shutdown().finally(() => process.exit(0));
});

await runAppChannel(config, {
	webShare: {
		access: webServer.access,
		publicBaseUrl: webServer.publicBaseUrl,
	},
});
