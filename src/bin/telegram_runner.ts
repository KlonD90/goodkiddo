import { createAppAgent } from "../app";
import type { AppConfig } from "../config";
import {
	type ApprovalBroker,
	type ApprovalOutcome,
	type ApprovalRequest,
	persistAlwaysRule,
} from "../permissions/approval";
import { FileAuditLogger } from "../permissions/audit";
import { maybeHandleCommand } from "../permissions/commands";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";

type TelegramUpdate = {
	update_id: number;
	message?: {
		chat?: { id?: number };
		text?: string;
	};
	callback_query?: {
		id: string;
		data?: string;
		from?: { id?: number };
		message?: { chat?: { id?: number } };
	};
};

type TelegramResponse<T> = {
	ok: boolean;
	result: T;
	description?: string;
};

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const APPROVAL_TIMEOUT_MS = 120_000;

type PendingApproval = {
	request: ApprovalRequest;
	resolve: (outcome: ApprovalOutcome) => void;
	timeout: NodeJS.Timeout;
	promptId: string;
};

type AgentSession = {
	agent: Awaited<ReturnType<typeof createAppAgent>>;
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

const extractTextFromContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === "string") return item;
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
		if (content !== "") return content;
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
		headers: { "content-type": "application/json" },
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
	extra: Record<string, unknown> = {},
): Promise<void> => {
	for (const chunk of chunkMessage(text)) {
		await callTelegram(token, "sendMessage", {
			chat_id: chatId,
			text: chunk,
			...extra,
		});
	}
};

const answerCallbackQuery = async (
	token: string,
	callbackQueryId: string,
): Promise<void> => {
	await callTelegram(token, "answerCallbackQuery", {
		callback_query_id: callbackQueryId,
	}).catch(() => undefined);
};

const getTelegramUpdates = async (
	token: string,
	offset: number,
): Promise<TelegramUpdate[]> =>
	callTelegram<TelegramUpdate[]>(token, "getUpdates", {
		offset,
		timeout: 30,
		allowed_updates: ["message", "callback_query"],
	});

class TelegramApprovalBroker implements ApprovalBroker {
	constructor(
		private readonly token: string,
		private readonly sessions: Map<string, AgentSession>,
		private readonly chatId: string,
		private readonly store: PermissionsStore,
	) {}

	async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
		const session = this.sessions.get(this.chatId);
		if (!session) return "deny-once";

		const promptId = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
		const summary = summarizeArgs(request.args);
		const text = `Approve tool call?\n${request.toolName}(${summary})`;
		const keyboard = {
			inline_keyboard: [
				[
					{ text: "Approve", callback_data: `approve-once:${promptId}` },
					{
						text: "Always allow",
						callback_data: `approve-always:${promptId}`,
					},
				],
				[
					{ text: "Deny", callback_data: `deny-once:${promptId}` },
					{ text: "Always deny", callback_data: `deny-always:${promptId}` },
				],
			],
		};

		await sendTelegramMessage(this.token, this.chatId, text, {
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

function summarizeArgs(args: unknown): string {
	try {
		const json = JSON.stringify(args);
		if (json.length <= 180) return json;
		return `${json.slice(0, 177)}...`;
	} catch {
		return String(args);
	}
}

async function ensureSession(
	chatId: string,
	caller: Caller,
	config: AppConfig,
	store: PermissionsStore,
	token: string,
	sessions: Map<string, AgentSession>,
): Promise<AgentSession> {
	const existing = sessions.get(chatId);
	if (existing) return existing;

	const broker = new TelegramApprovalBroker(token, sessions, chatId, store);
	const audit = new FileAuditLogger("./permissions.log");
	const agent = await createAppAgent(config, { caller, store, broker, audit });
	const session: AgentSession = {
		agent,
		running: false,
		queue: [],
		pending: null,
		threadId: `telegram-${chatId}`,
	};
	sessions.set(chatId, session);
	return session;
}

async function runAgentTurn(
	session: AgentSession,
	token: string,
	chatId: string,
	userInput: string,
): Promise<void> {
	try {
		const result = await session.agent.invoke(
			{ messages: [{ role: "user", content: userInput }] },
			{ configurable: { thread_id: session.threadId } },
		);
		const reply = extractAgentReply(result);
		await sendTelegramMessage(token, chatId, reply);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown Telegram bot error";
		await sendTelegramMessage(token, chatId, `Request failed: ${message}`);
	}
}

async function pumpQueue(
	session: AgentSession,
	token: string,
	chatId: string,
): Promise<void> {
	if (session.running) return;
	const next = session.queue.shift();
	if (next === undefined) return;
	session.running = true;
	try {
		await runAgentTurn(session, token, chatId, next);
	} finally {
		session.running = false;
		if (session.queue.length > 0) {
			void pumpQueue(session, token, chatId);
		}
	}
}

function maybeHandleApprovalReply(
	session: AgentSession,
	text: string,
): boolean {
	if (!session.pending) return false;
	const normalized = text.trim().toLowerCase();
	if (["yes", "y", "approve"].includes(normalized)) {
		const pending = session.pending;
		session.pending = null;
		pending.resolve("approve-once");
		return true;
	}
	if (["always", "a"].includes(normalized)) {
		const pending = session.pending;
		session.pending = null;
		pending.resolve("approve-always");
		return true;
	}
	if (["no", "n", "deny"].includes(normalized)) {
		const pending = session.pending;
		session.pending = null;
		pending.resolve("deny-once");
		return true;
	}
	if (["never", "d"].includes(normalized)) {
		const pending = session.pending;
		session.pending = null;
		pending.resolve("deny-always");
		return true;
	}
	return false;
}

export const runTelegramEntrypoint = async (
	config: AppConfig,
): Promise<void> => {
	const token = config.telegramBotToken;
	const store = new PermissionsStore({ dbPath: config.stateDbPath });
	const sessions = new Map<string, AgentSession>();

	console.log("Starting Telegram bot polling loop (multi-tenant mode).");
	if (config.telegramAllowedChatId !== "") {
		console.warn(
			"TELEGRAM_BOT_ALLOWED_CHAT_ID is deprecated; access is now governed by harness_users. Ignoring.",
		);
	}

	let offset = 0;
	while (true) {
		const updates = await getTelegramUpdates(token, offset);
		for (const update of updates) {
			offset = update.update_id + 1;

			if (update.callback_query) {
				const callback = update.callback_query;
				const chatId = callback.message?.chat?.id;
				if (chatId === undefined || !callback.data) {
					await answerCallbackQuery(token, callback.id);
					continue;
				}
				const chatIdString = String(chatId);
				const session = sessions.get(chatIdString);
				const [outcome, promptId] = callback.data.split(":", 2);
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
					pending.resolve(outcome);
				}
				await answerCallbackQuery(token, callback.id);
				continue;
			}

			const chatId = update.message?.chat?.id;
			const text = update.message?.text?.trim();
			if (chatId === undefined || text === undefined || text === "") continue;

			const chatIdString = String(chatId);
			const user = store.getUser("telegram", chatIdString);
			if (!user || user.status === "suspended") {
				await sendTelegramMessage(
					token,
					chatIdString,
					config.blockedUserMessage,
				);
				continue;
			}

			const caller: Caller = {
				id: user.id,
				entrypoint: "telegram",
				externalId: user.externalId,
				displayName: user.displayName ?? undefined,
			};

			const session = await ensureSession(
				chatIdString,
				caller,
				config,
				store,
				token,
				sessions,
			);

			if (maybeHandleApprovalReply(session, text)) continue;

			const command = maybeHandleCommand(text, caller, store);
			if (command.handled) {
				await sendTelegramMessage(token, chatIdString, command.reply);
				continue;
			}

			session.queue.push(text);
			void pumpQueue(session, token, chatIdString);
		}
	}
};
