import { maskSecret, resolveConfig } from "../config";
import { runAppChannel } from "../channels";

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
await runAppChannel(config);
