import { Bot, InlineKeyboard } from "grammy";
import type { AppConfig } from "../config";
import {
	type ApprovalBroker,
	type ApprovalOutcome,
	type ApprovalRequest,
	persistAlwaysRule,
} from "../permissions/approval";
import { maybeHandleCommand } from "../permissions/commands";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import {
	createChannelAgentSession,
	extractAgentReply,
	type AgentInstance,
} from "./shared";
import type { AppChannel } from "./types";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const APPROVAL_TIMEOUT_MS = 120_000;

type PendingApproval = {
	request: ApprovalRequest;
	resolve: (outcome: ApprovalOutcome) => Promise<void>;
	timeout: NodeJS.Timeout;
	promptId: string;
};

type TelegramAgentSession = {
	agent: AgentInstance;
	running: boolean;
	queue: string[];
	pending: PendingApproval | null;
	threadId: string;
};

const chunkMessage = (text: string): string[] => {
	if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [text];
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

async function sendTelegramMessage(
	bot: Bot,
	chatId: string,
	text: string,
	options: Record<string, unknown> = {},
): Promise<void> {
	for (const chunk of chunkMessage(text)) {
		await bot.api.sendMessage(chatId, chunk, options);
	}
}

function summarizeArgs(args: unknown): string {
	try {
		const json = JSON.stringify(args);
		if (json.length <= 180) return json;
		return `${json.slice(0, 177)}...`;
	} catch {
		return String(args);
	}
}

class TelegramApprovalBroker implements ApprovalBroker {
	constructor(
		private readonly bot: Bot,
		private readonly sessions: Map<string, TelegramAgentSession>,
		private readonly chatId: string,
		private readonly store: PermissionsStore,
	) {}

	async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
		const session = this.sessions.get(this.chatId);
		if (!session) return "deny-once";

		const promptId = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
		const summary = summarizeArgs(request.args);
		const text = `Approve tool call?\n${request.toolName}(${summary})`;
		const keyboard = new InlineKeyboard()
			.text("Approve", `approve-once:${promptId}`)
			.text("Always allow", `approve-always:${promptId}`)
			.row()
			.text("Deny", `deny-once:${promptId}`)
			.text("Always deny", `deny-always:${promptId}`);

		await sendTelegramMessage(this.bot, this.chatId, text, {
			reply_markup: keyboard,
		});

		return await new Promise<ApprovalOutcome>((resolve) => {
			const timeout = setTimeout(() => {
				if (session.pending?.promptId === promptId) {
					session.pending = null;
					resolve("deny-once");
				}
			}, APPROVAL_TIMEOUT_MS);

			const wrappedResolve = async (outcome: ApprovalOutcome) => {
				clearTimeout(timeout);
				if (outcome === "approve-always" || outcome === "deny-always") {
					await persistAlwaysRule(
						this.store,
						request.caller,
						request.toolName,
						request.args,
						outcome === "approve-always" ? "allow" : "deny",
					);
				}
				resolve(outcome);
			};

			session.pending = {
				request,
				resolve: wrappedResolve,
				timeout,
				promptId,
			};
		});
	}
}

async function ensureTelegramSession(
	chatId: string,
	caller: Caller,
	config: AppConfig,
	store: PermissionsStore,
	bot: Bot,
	sessions: Map<string, TelegramAgentSession>,
): Promise<TelegramAgentSession> {
	const existing = sessions.get(chatId);
	if (existing) return existing;

	const broker = new TelegramApprovalBroker(bot, sessions, chatId, store);
	const session = await createChannelAgentSession(config, {
		caller,
		store,
		broker,
		threadId: `telegram-${chatId}`,
	});
	const telegramSession: TelegramAgentSession = {
		...session,
		running: false,
		queue: [],
		pending: null,
	};
	sessions.set(chatId, telegramSession);
	return telegramSession;
}

async function runAgentTurn(
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
	userInput: string,
): Promise<void> {
	try {
		const result = await session.agent.invoke(
			{ messages: [{ role: "user", content: userInput }] },
			{ configurable: { thread_id: session.threadId } },
		);
		const reply = extractAgentReply(result);
		await sendTelegramMessage(bot, chatId, reply);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown Telegram bot error";
		await sendTelegramMessage(bot, chatId, `Request failed: ${message}`);
	}
}

async function pumpQueue(
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
): Promise<void> {
	if (session.running) return;
	const next = session.queue.shift();
	if (next === undefined) return;
	session.running = true;
	try {
		await runAgentTurn(session, bot, chatId, next);
	} finally {
		session.running = false;
		if (session.queue.length > 0) {
			void pumpQueue(session, bot, chatId);
		}
	}
}

function maybeHandleApprovalReply(
	session: TelegramAgentSession,
	text: string,
): boolean {
	if (!session.pending) return false;
	const normalized = text.trim().toLowerCase();
	if (["yes", "y", "approve"].includes(normalized)) {
		const pending = session.pending;
		session.pending = null;
		void pending.resolve("approve-once");
		return true;
	}
	if (["always", "a"].includes(normalized)) {
		const pending = session.pending;
		session.pending = null;
		void pending.resolve("approve-always");
		return true;
	}
	if (["no", "n", "deny"].includes(normalized)) {
		const pending = session.pending;
		session.pending = null;
		void pending.resolve("deny-once");
		return true;
	}
	if (["never", "d"].includes(normalized)) {
		const pending = session.pending;
		session.pending = null;
		void pending.resolve("deny-always");
		return true;
	}
	return false;
}

export const telegramChannel: AppChannel = {
	entrypoint: "telegram",
	async run(config: AppConfig): Promise<void> {
		const store = new PermissionsStore({ dbPath: config.stateDbPath });
		const sessions = new Map<string, TelegramAgentSession>();
		const bot = new Bot(config.telegramBotToken);

		console.log("Starting Telegram bot polling loop with grammy.");
		if (config.telegramAllowedChatId !== "") {
			console.warn(
				"TELEGRAM_BOT_ALLOWED_CHAT_ID is deprecated; access is now governed by harness_users. Ignoring.",
			);
		}

		bot.on("callback_query:data", async (ctx) => {
			const chatId = ctx.chat?.id;
			const data = ctx.callbackQuery.data;
			if (chatId === undefined || data === "") {
				await ctx.answerCallbackQuery().catch(() => undefined);
				return;
			}

			const chatIdString = String(chatId);
			const session = sessions.get(chatIdString);
			const [outcome, promptId] = data.split(":", 2);
			if (
				session?.pending &&
				session.pending.promptId === promptId &&
				(outcome === "approve-once" ||
					outcome === "approve-always" ||
					outcome === "deny-once" ||
					outcome === "deny-always")
			) {
				const pending = session.pending;
				session.pending = null;
				await pending.resolve(outcome);
			}

			await ctx.answerCallbackQuery().catch(() => undefined);
		});

		bot.on("message:text", async (ctx) => {
			const chatId = ctx.chat.id;
			const text = ctx.message.text.trim();
			if (text === "") return;

			const chatIdString = String(chatId);
			const user = store.getUser("telegram", chatIdString);
			if (!user || user.status === "suspended") {
				await sendTelegramMessage(bot, chatIdString, config.blockedUserMessage);
				return;
			}

			const caller: Caller = {
				id: user.id,
				entrypoint: "telegram",
				externalId: user.externalId,
				displayName: user.displayName ?? undefined,
			};

			const session = await ensureTelegramSession(
				chatIdString,
				caller,
				config,
				store,
				bot,
				sessions,
			);

			if (maybeHandleApprovalReply(session, text)) return;

			const command = maybeHandleCommand(text, caller, store);
			if (command.handled) {
				await sendTelegramMessage(bot, chatIdString, command.reply);
				return;
			}

			session.queue.push(text);
			void pumpQueue(session, bot, chatIdString);
		});

		bot.catch(async (error) => {
			console.error("Telegram bot error:", error.error);
		});

		await bot.start({
			onStart: (botInfo) => {
				console.log(`Telegram bot connected as @${botInfo.username}`);
			},
		});
	},
};
