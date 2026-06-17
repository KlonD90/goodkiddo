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

type DebounceEntry = {
	timeoutId: ReturnType<typeof setTimeout>;
	message: string;
};

export class TelegramOutboundChannel implements OutboundChannel {
	private readonly debounceMs: number;
	private readonly debounces = new Map<string, DebounceEntry>();

	constructor(
		private readonly bot: Bot,
		private readonly resolveChatId: (callerId: string) => string | null,
		debounceMs?: number,
	) {
		this.debounceMs =
			debounceMs !== undefined && Number.isFinite(debounceMs) && debounceMs >= 0
				? debounceMs
				: 5000;
	}

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

		const existing = this.debounces.get(callerId);
		if (existing) {
			clearTimeout(existing.timeoutId);
			existing.message = message;
			existing.timeoutId = setTimeout(
				() => void this.flushStatus(callerId, chatId),
				this.debounceMs,
			);
			return;
		}

		this.debounces.set(callerId, {
			timeoutId: setTimeout(
				() => void this.flushStatus(callerId, chatId),
				this.debounceMs,
			),
			message,
		});
	}

	private async flushStatus(callerId: string, chatId: string): Promise<void> {
		const entry = this.debounces.get(callerId);
		if (!entry) return;
		this.debounces.delete(callerId);
		try {
			await this.bot.api.sendMessage(chatId, entry.message);
		} catch (err) {
			log.error("sendStatus failed", {
				chatId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
