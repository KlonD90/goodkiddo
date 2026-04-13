import { createAppAgent } from "../app";
import type { AppConfig } from "../config";

type TelegramUpdate = {
	update_id: number;
	message?: {
		chat?: { id?: number };
		text?: string;
	};
};

type TelegramResponse<T> = {
	ok: boolean;
	result: T;
	description?: string;
};

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

const chunkMessage = (text: string): string[] => {
	if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
		return [text];
	}

	const chunks: string[] = [];
	for (
		let start = 0;
		start < text.length;
		start += TELEGRAM_MAX_MESSAGE_LENGTH
	) {
		chunks.push(text.slice(start, start + TELEGRAM_MAX_MESSAGE_LENGTH));
	}
	return chunks;
};

const extractTextFromContent = (content: unknown): string => {
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === "string") {
					return item;
				}

				if (
					typeof item === "object" &&
					item !== null &&
					"text" in item &&
					typeof item.text === "string"
				) {
					return item.text;
				}

				return "";
			})
			.filter((item) => item !== "")
			.join("\n");
	}

	return "";
};

const extractAgentReply = (result: {
	messages?: Array<{ content?: unknown }>;
}): string => {
	const messages = result.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const content = extractTextFromContent(messages[index]?.content);
		if (content !== "") {
			return content;
		}
	}

	return "The agent completed the task but did not return a text response.";
};

const callTelegram = async <T>(
	token: string,
	method: string,
	body: Record<string, unknown>,
): Promise<T> => {
	const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		throw new Error(
			`Telegram API ${method} failed with HTTP ${response.status}`,
		);
	}

	const payload = (await response.json()) as TelegramResponse<T>;
	if (!payload.ok) {
		throw new Error(payload.description ?? `Telegram API ${method} failed`);
	}

	return payload.result;
};

const sendTelegramMessage = async (
	token: string,
	chatId: string,
	text: string,
): Promise<void> => {
	for (const chunk of chunkMessage(text)) {
		await callTelegram(token, "sendMessage", {
			chat_id: chatId,
			text: chunk,
		});
	}
};

const getTelegramUpdates = async (
	token: string,
	offset: number,
): Promise<TelegramUpdate[]> =>
	callTelegram<TelegramUpdate[]>(token, "getUpdates", {
		offset,
		timeout: 30,
		allowed_updates: ["message"],
	});

export const runTelegramEntrypoint = async (
	config: AppConfig,
): Promise<void> => {
	const token = config.telegramBotToken;
	const allowedChatId = config.telegramAllowedChatId;
	const agent = await createAppAgent(config);

	console.log("Starting Telegram bot polling loop.");
	if (allowedChatId !== "") {
		console.log(`Telegram access restricted to chat ${allowedChatId}.`);
	}

	let offset = 0;
	while (true) {
		const updates = await getTelegramUpdates(token, offset);
		for (const update of updates) {
			offset = update.update_id + 1;
			const chatId = update.message?.chat?.id;
			const text = update.message?.text?.trim();

			if (chatId === undefined || text === undefined || text === "") {
				continue;
			}

			const chatIdString = String(chatId);
			if (allowedChatId !== "" && chatIdString !== allowedChatId) {
				await sendTelegramMessage(
					token,
					chatIdString,
					"This bot is not enabled for this chat.",
				);
				continue;
			}

			try {
				const result = await agent.invoke({
					messages: [{ role: "user", content: text }],
				});
				const reply = extractAgentReply(result);
				await sendTelegramMessage(token, chatIdString, reply);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown Telegram bot error";
				await sendTelegramMessage(
					token,
					chatIdString,
					`Request failed: ${message}`,
				);
			}
		}
	}
};
