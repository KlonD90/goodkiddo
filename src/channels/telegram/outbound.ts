import type { Bot } from "grammy";
import {
	chunkRenderedTelegramMessages,
} from "./streaming";
import { createLogger } from "../../logger";
import type { OutboundChannel, OutboundSendFileArgs, OutboundSendResult } from "../outbound";
import { renderTelegramCaptionHtml } from "./markdown";
import { TELEGRAM_HTML_PARSE_MODE, TELEGRAM_MAX_CAPTION_LENGTH, TELEGRAM_TYPING_INTERVAL_MS } from "./types";
import { basenameFromPath } from "../../utils/filesystem";

const log = createLogger("telegram");

export async function sendTelegramMessage(
	bot: Bot,
	chatId: string,
	text: string,
	options: Record<string, unknown> = {},
): Promise<void> {
	const chunks = chunkRenderedTelegramMessages(text);
	log.debug("sending message", {
		chatId,
		chunks: chunks.length,
		length: text.length,
	});
	for (const chunk of chunks) {
		await bot.api.sendMessage(chatId, chunk, {
			parse_mode: TELEGRAM_HTML_PARSE_MODE,
			...options,
		});
	}
}

export async function sendTelegramTyping(bot: Bot, chatId: string): Promise<void> {
	try {
		await bot.api.sendChatAction(chatId, "typing");
	} catch (err) {
		log.debug("sendChatAction failed", {
			chatId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export function startTelegramTypingLoop(bot: Bot, chatId: string): () => void {
	void sendTelegramTyping(bot, chatId);
	const timer = setInterval(() => {
		void sendTelegramTyping(bot, chatId);
	}, TELEGRAM_TYPING_INTERVAL_MS);

	return () => {
		clearInterval(timer);
	};
}

export class TelegramOutboundChannel implements OutboundChannel {
	constructor(
		private readonly bot: Bot,
		private readonly resolveChatId: (callerId: string) => string | null,
	) {}

	async sendFile(args: OutboundSendFileArgs): Promise<OutboundSendResult> {
		const chatId = this.resolveChatId(args.callerId);
		if (!chatId) {
			return {
				ok: false,
				error: `No active telegram chat for caller '${args.callerId}'.`,
			};
		}

		const filename = basenameFromPath(args.path) || "file";
		const buffer = Buffer.from(
			args.bytes.buffer,
			args.bytes.byteOffset,
			args.bytes.byteLength,
		);

		try {
			const caption =
				typeof args.caption === "string" && args.caption !== ""
					? renderTelegramCaptionHtml(args.caption)
					: null;
			if (caption !== null && caption.length > TELEGRAM_MAX_CAPTION_LENGTH) {
				return {
					ok: false,
					error: `Rendered caption is too long (${caption.length} chars). Telegram captions are limited to ${TELEGRAM_MAX_CAPTION_LENGTH} characters after formatting.`,
				};
			}

			const { InputFile } = await import("grammy");
			await this.bot.api.sendDocument(chatId, new InputFile(buffer, filename), {
				caption: caption ?? undefined,
				parse_mode: caption ? TELEGRAM_HTML_PARSE_MODE : undefined,
			});
			return { ok: true };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "unknown telegram error";
			return { ok: false, error: message };
		}
	}

	async sendStatus(callerId: string, message: string): Promise<void> {
		const chatId = this.resolveChatId(callerId);
		if (!chatId) return;
		try {
			await this.bot.api.sendMessage(chatId, message);
		} catch (err) {
			log.error("sendStatus failed", {
				chatId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
