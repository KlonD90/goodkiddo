import { type Bot, InlineKeyboard } from "grammy";
import { trackBotStarted, trackUserCreated } from "../../analytics";
import { createLogger } from "../../logger";
import { readThreadMessages } from "../../memory/rotate_thread";
import type {
	ApprovalOutcome,
	ApprovalRequest,
} from "../../permissions/approval";
import { persistAlwaysRule } from "../../permissions/approval";
import { maybeHandleCommand } from "../../permissions/commands";
import type { PermissionsStore } from "../../permissions/store";
import type { Caller } from "../../permissions/types";
import { maybeHandleSessionCommand } from "../session_commands";
import {
	clearPendingTaskCheckContext,
	extractAgentReply,
	extractTextFromContent,
	refreshAgentIfPromptDirty,
} from "../shared";
import type { ChannelRunOptions } from "../types";
import { applyTelegramAttachmentBudget } from "./attachment";
import { escapeTelegramHtml } from "./markdown";
import { sendTelegramMessage, startTelegramTypingLoop } from "./outbound";
import {
	mergeTelegramStreamText,
	takeTelegramOverflowStreamChunks,
	takeTelegramParagraphStreamChunks,
	takeTelegramStreamChunks,
} from "./streaming";
import type {
	TelegramAgentSession,
	TelegramAttachmentBudget,
	TelegramImageContentBlock,
	TelegramQueuedTurn,
	TelegramTextContentBlock,
	TelegramUserInput,
} from "./types";
import {
	APPROVAL_TIMEOUT_MS,
	TELEGRAM_COMMANDS,
	TELEGRAM_STREAM_PARAGRAPH_FLUSH_INTERVAL_MS,
} from "./types";

const log = createLogger("telegram");

// --- Agent reply extraction ---

export function extractTelegramReplyFromAgentState(state: unknown): string {
	if (
		typeof state !== "object" ||
		state === null ||
		!("values" in state) ||
		typeof state.values !== "object" ||
		state.values === null
	) {
		return "";
	}

	const reply = extractAgentReply(
		state.values as { messages?: Array<{ content?: unknown }> },
	);
	return reply ===
		"The agent completed the task but did not return a text response."
		? ""
		: reply;
}

async function getTelegramFinalAgentReply(
	session: TelegramAgentSession,
): Promise<string> {
	try {
		const state = await session.agent.getState({
			configurable: { thread_id: session.threadId },
		});
		return extractTelegramReplyFromAgentState(state);
	} catch {
		return "";
	}
}

// --- Stream text extraction ---

function extractTelegramStreamText(message: unknown): string {
	if (
		typeof message !== "object" ||
		message === null ||
		!("getType" in message) ||
		typeof message.getType !== "function" ||
		message.getType() !== "ai"
	) {
		return "";
	}

	if (
		"text" in message &&
		typeof message.text === "string" &&
		message.text !== ""
	) {
		return message.text;
	}

	if ("content" in message) {
		return extractTextFromContent(message.content);
	}

	return "";
}

// --- Command helpers ---

export function extractTelegramCommandName(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const firstSpace = trimmed.indexOf(" ");
	const rawCommand = (
		firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
	)
		.slice(1)
		.toLowerCase();
	const command = rawCommand.split("@", 1)[0] ?? "";
	return command === "" ? null : command;
}

export function formatUnknownTelegramCommandReply(command: string): string {
	const knownCommands = TELEGRAM_COMMANDS.map(
		({ command: knownCommand }) => `/${knownCommand}`,
	).join(", ");
	return `Unknown command: /${command}\nAvailable commands: ${knownCommands}`;
}

export function renderTelegramWelcomeMessage(): string {
	return [
		"Welcome. Send me a normal request in plain language and I will help from here.",
		"",
		"Useful ways to start:",
		"- Ask for writing, research, planning, coding, or file help.",
		"- Send supported files when you want me to read or work with them.",
		"- Use /identity to choose how I should behave.",
		"- Use /new_thread when you want a clean conversation.",
	].join("\n");
}

export function isTelegramStartCommand(text: string): boolean {
	return extractTelegramCommandName(text) === "start";
}

export async function maybeHandleTelegramStartCommand(
	bot: Bot,
	chatId: string,
	text: string,
	isNewUser: boolean,
): Promise<boolean> {
	if (!isTelegramStartCommand(text)) return false;
	const spaceIdx = text.indexOf(" ");
	const source = spaceIdx !== -1 ? text.slice(spaceIdx + 1).trim() : "";
	if (source !== "") {
		trackBotStarted(chatId, source);
	} else if (isNewUser) {
		trackBotStarted(chatId, "unknown");
	}
	await sendTelegramMessage(bot, chatId, renderTelegramWelcomeMessage());
	return true;
}

export async function getTelegramCaller(
	store: PermissionsStore,
	chatId: string,
): Promise<{ caller: Caller; isNew: boolean } | null> {
	const user = await store.getUser("telegram", chatId);
	if (user) {
		if (user.status === "suspended") return null;
		return {
			caller: {
				id: user.id,
				entrypoint: "telegram",
				externalId: user.externalId,
				displayName: user.displayName ?? undefined,
			},
			isNew: false,
		};
	}
	await store.createUserFree({
		entrypoint: "telegram",
		externalId: chatId,
	});
	trackUserCreated(chatId, "telegram");
	const newUser = await store.getUser("telegram", chatId);
	if (!newUser) return null;
	return {
		caller: {
			id: newUser.id,
			entrypoint: "telegram",
			externalId: newUser.externalId,
			displayName: newUser.displayName ?? undefined,
		},
		isNew: true,
	};
}

// --- Approval ---

function summarizeArgs(args: unknown): string {
	try {
		const json = JSON.stringify(args);
		if (json.length <= 180) return json;
		return `${json.slice(0, 177)}...`;
	} catch {
		return String(args);
	}
}

export function maybeHandleTelegramApprovalReply(
	session: TelegramAgentSession,
	text: string,
): { handled: boolean; reply?: string } {
	const pendingCount = session.pendingApprovals.size;
	const pending = session.pendingApprovals.values().next().value;
	if (!pending) return { handled: false };
	const normalized = text.trim().toLowerCase();
	if (["yes", "y", "approve"].includes(normalized)) {
		if (pendingCount > 1) {
			return {
				handled: true,
				reply:
					"Several approvals are pending. Use the buttons on the specific prompt instead of plain text.",
			};
		}
		session.pendingApprovals.delete(pending.promptId);
		void pending.resolve("approve-once");
		return { handled: true };
	}
	if (["always", "a"].includes(normalized)) {
		if (pendingCount > 1) {
			return {
				handled: true,
				reply:
					"Several approvals are pending. Use the buttons on the specific prompt instead of plain text.",
			};
		}
		session.pendingApprovals.delete(pending.promptId);
		void pending.resolve("approve-always");
		return { handled: true };
	}
	if (["no", "n", "deny"].includes(normalized)) {
		if (pendingCount > 1) {
			return {
				handled: true,
				reply:
					"Several approvals are pending. Use the buttons on the specific prompt instead of plain text.",
			};
		}
		session.pendingApprovals.delete(pending.promptId);
		void pending.resolve("deny-once");
		return { handled: true };
	}
	if (["never", "d"].includes(normalized)) {
		if (pendingCount > 1) {
			return {
				handled: true,
				reply:
					"Several approvals are pending. Use the buttons on the specific prompt instead of plain text.",
			};
		}
		session.pendingApprovals.delete(pending.promptId);
		void pending.resolve("deny-always");
		return { handled: true };
	}
	return { handled: false };
}

// --- Control input ---

export async function handleTelegramControlInput(
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
	commandText: string,
	caller: Caller,
	store: PermissionsStore,
	webShare: ChannelRunOptions["webShare"],
): Promise<boolean> {
	if (commandText !== "") {
		const approvalReply = maybeHandleTelegramApprovalReply(
			session,
			commandText,
		);
		if (approvalReply.handled) {
			if (approvalReply.reply) {
				await sendTelegramMessage(bot, chatId, approvalReply.reply);
			}
			return true;
		}

		if (session.running) {
			return false;
		}

		const sessionCommand = await maybeHandleSessionCommand(commandText, {
			session,
			model: session.model,
			backend: session.workspace,
			mintThreadId: () => mintTelegramThreadId(chatId),
			compaction: session.compactionConfig
				? {
						caller: session.compactionConfig.caller,
						store: session.compactionConfig.store,
					}
				: undefined,
			webShare: webShare
				? {
						access: webShare.access,
						publicBaseUrl: webShare.publicBaseUrl,
						callerId: caller.id,
					}
				: undefined,
			identity: {
				store,
				callerId: caller.id,
			},
		});
		if (sessionCommand.handled) {
			await sendTelegramMessage(bot, chatId, sessionCommand.reply);
			return true;
		}

		const command = await maybeHandleCommand(commandText, caller, store);
		if (command.handled) {
			await sendTelegramMessage(bot, chatId, command.reply);
			return true;
		}

		const slashCommand = extractTelegramCommandName(commandText);
		if (slashCommand !== null) {
			await sendTelegramMessage(
				bot,
				chatId,
				formatUnknownTelegramCommandReply(slashCommand),
			);
			return true;
		}
	}

	return false;
}

// --- Thread ID ---

function mintTelegramThreadId(chatId: string): string {
	return `telegram-${chatId}-${Date.now()}`;
}

// --- Agent turn ---

async function runAgentTurn(
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
	queuedTurn: TelegramQueuedTurn,
): Promise<void> {
	const stopTyping = startTelegramTypingLoop(bot, chatId);
	try {
		session.currentUserText =
			queuedTurn.currentUserText ?? extractTextFromContent(queuedTurn.content);
		session.currentTurnContext = {
			now: queuedTurn.currentMessageDate ?? new Date(),
			source: queuedTurn.currentMessageDate
				? "telegram_message"
				: "system_clock",
			requiresExplicitTimerTimezone: true,
		};
		await session.refreshAgent();
		const currentMessages = await readThreadMessages(
			session.agent,
			session.threadId,
		);
		const preparedTurn = await prepareSessionForIncomingTurn(
			session,
			currentMessages,
			queuedTurn.content,
			() => mintTelegramThreadId(chatId),
		);
		const taskCheck = await maybeRunPendingTaskCheck(
			session,
			queuedTurn.currentUserText ?? queuedTurn.content,
		);
		if (taskCheck.handled) {
			await sendTelegramMessage(bot, chatId, taskCheck.reply ?? "");
			return;
		}
		if (preparedTurn.compacted || taskCheck.needsRefresh) {
			await session.refreshAgent();
		}
		if (queuedTurn.attachmentBudget) {
			const budgetResult = await applyTelegramAttachmentBudget({
				session,
				budget: queuedTurn.attachmentBudget,
				content: queuedTurn.content,
				currentUserText: queuedTurn.currentUserText,
				currentMessages: preparedTurn.currentMessages,
				alreadyCompacted: preparedTurn.compacted,
				mintThreadId: () => mintTelegramThreadId(chatId),
			});
			if (!budgetResult.ok) {
				await sendTelegramMessage(bot, chatId, budgetResult.userMessage);
				return;
			}
		}
		const invokeMessages = buildInvokeMessages(session, {
			role: "user",
			content: queuedTurn.content,
		});

		const stream = await session.agent.stream(
			{ messages: invokeMessages },
			{
				configurable: { thread_id: session.threadId },
				streamMode: "messages",
				recursionLimit: session.recursionLimit,
			},
		);
		let pendingReply = "";
		let streamedReply = "";
		let sentAnyReply = false;
		const streamIterator = stream[Symbol.asyncIterator]();
		const flushTick = Symbol("telegram-stream-flush-tick");
		let nextChunk = streamIterator.next();

		while (true) {
			let flushTimer: ReturnType<typeof setTimeout> | undefined;
			const flushPromise = new Promise<typeof flushTick>((resolve) => {
				flushTimer = setTimeout(
					() => resolve(flushTick),
					TELEGRAM_STREAM_PARAGRAPH_FLUSH_INTERVAL_MS,
				);
			});
			const raced = await Promise.race([nextChunk, flushPromise]);
			if (flushTimer !== undefined) clearTimeout(flushTimer);
			if (raced === flushTick) {
				const flushable = takeTelegramParagraphStreamChunks(pendingReply);
				pendingReply = flushable.remainder;
				for (const part of flushable.chunks) {
					await sendTelegramMessage(bot, chatId, part);
					sentAnyReply = true;
				}

				const overflowFlush = takeTelegramOverflowStreamChunks(pendingReply);
				pendingReply = overflowFlush.remainder;
				for (const part of overflowFlush.chunks) {
					await sendTelegramMessage(bot, chatId, part);
					sentAnyReply = true;
				}
				continue;
			}

			if (raced.done) break;
			nextChunk = streamIterator.next();
			const chunk = raced.value;
			if (!Array.isArray(chunk) || chunk.length < 1) continue;
			const message = chunk[0];
			const text = extractTelegramStreamText(message);
			if (text === "") continue;

			const merged = mergeTelegramStreamText(streamedReply, text);
			streamedReply = merged.fullText;
			if (merged.delta === "") continue;

			pendingReply += merged.delta;
			const flushable = takeTelegramParagraphStreamChunks(pendingReply);
			pendingReply = flushable.remainder;
			for (const part of flushable.chunks) {
				await sendTelegramMessage(bot, chatId, part);
				sentAnyReply = true;
			}

			const overflowFlush = takeTelegramOverflowStreamChunks(pendingReply);
			pendingReply = overflowFlush.remainder;
			for (const part of overflowFlush.chunks) {
				await sendTelegramMessage(bot, chatId, part);
				sentAnyReply = true;
			}
		}

		const finalFlush = takeTelegramStreamChunks(pendingReply, true);
		for (const part of finalFlush.chunks) {
			await sendTelegramMessage(bot, chatId, part);
			sentAnyReply = true;
		}

		if (!sentAnyReply) {
			const finalReply = await getTelegramFinalAgentReply(session);
			if (finalReply !== "") {
				await sendTelegramMessage(bot, chatId, finalReply);
				sentAnyReply = true;
			}
		}

		if (!sentAnyReply) {
			await sendTelegramMessage(
				bot,
				chatId,
				"The agent completed the task but did not return a text response.",
			);
		}
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown Telegram bot error";
		await sendTelegramMessage(
			bot,
			chatId,
			`Request failed: ${escapeTelegramHtml(message)}`,
		);
	} finally {
		clearPendingTaskCheckContext(session);
		session.currentUserText = undefined;
		session.currentTurnContext = undefined;
		await refreshAgentIfPromptDirty(session);
		stopTyping();
	}
}

// --- Queue merge ---

function mergeContent(
	base: TelegramUserInput,
	incoming: TelegramUserInput,
): { success: true; merged: TelegramUserInput } | { success: false } {
	const baseHasImage =
		Array.isArray(base) && base.some((b) => b.type === "image");
	const incomingHasImage =
		Array.isArray(incoming) && incoming.some((i) => i.type === "image");

	if (baseHasImage || incomingHasImage) {
		return { success: false };
	}

	if (typeof base === "string" && typeof incoming === "string") {
		return { success: true, merged: base + "\n" + incoming };
	}

	if (typeof base === "string" && Array.isArray(incoming)) {
		const combined: Array<TelegramTextContentBlock | TelegramImageContentBlock> = [
			{ type: "text", text: base },
			...incoming,
		];
		return { success: true, merged: combined };
	}

	if (Array.isArray(base) && typeof incoming === "string") {
		const combined: Array<TelegramTextContentBlock | TelegramImageContentBlock> = [
			...base,
			{ type: "text", text: incoming },
		];
		return { success: true, merged: combined };
	}

	if (Array.isArray(base) && Array.isArray(incoming)) {
		const combined: Array<TelegramTextContentBlock | TelegramImageContentBlock> = [
			...base,
			...incoming,
		];
		return { success: true, merged: combined };
	}

	return { success: false };
}

function extractTextFromUserInput(content: TelegramUserInput): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TelegramTextContentBlock => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function tryMergeQueuedTurns(
	base: TelegramQueuedTurn,
	incoming: TelegramQueuedTurn,
): { success: true; merged: TelegramQueuedTurn } | { success: false } {
	const contentMerge = mergeContent(base.content, incoming.content);
	if (!contentMerge.success) {
		return { success: false };
	}

	const baseText = base.currentUserText ?? extractTextFromUserInput(base.content);
	const incomingText =
		incoming.currentUserText ?? extractTextFromUserInput(incoming.content);

	return {
		success: true,
		merged: {
			content: contentMerge.merged,
			commandText: "",
			currentUserText: baseText + (incomingText ? "\n" + incomingText : ""),
			currentMessageDate: base.currentMessageDate ?? incoming.currentMessageDate,
			attachmentBudget: base.attachmentBudget ?? incoming.attachmentBudget,
		},
	};
}

function isSessionCommandClearingQueue(commandText: string): boolean {
	const trimmed = commandText.trim();
	if (!trimmed.startsWith("/")) return false;
	const firstSpace = trimmed.indexOf(" ");
	const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace))
		.slice(1)
		.toLowerCase();
	if (command === "new-thread" || command === "new_thread") return true;
	if (command.startsWith("identity")) return true;
	return false;
}

// --- Queue pump ---

async function pumpQueue(
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
): Promise<void> {
	if (session.running) return;

	const current = session.queue.shift();
	if (current === undefined) return;

	session.running = true;
	try {
		let accumulated = current;

		while (session.queue.length > 0) {
			const next = session.queue[0];
			const mergeResult = tryMergeQueuedTurns(accumulated, next);
			if (!mergeResult.success) break;
			session.queue.shift();
			accumulated = mergeResult.merged;
		}

		await runAgentTurn(session, bot, chatId, accumulated);
	} finally {
		session.running = false;
		if (session.queue.length > 0) {
			void pumpQueue(session, bot, chatId);
		}
	}
}

// --- Queue turn ---

export async function handleTelegramQueuedTurn(
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
	commandText: string,
	content: TelegramUserInput,
	caller: Caller,
	store: PermissionsStore,
	webShare: ChannelRunOptions["webShare"],
	currentUserText?: string,
	attachmentBudget?: TelegramAttachmentBudget,
	currentMessageDate?: Date,
): Promise<void> {
	if (
		await handleTelegramControlInput(
			session,
			bot,
			chatId,
			commandText,
			caller,
			store,
			webShare,
		)
	) {
		return;
	}

	if (isSessionCommandClearingQueue(commandText)) {
		session.queue = [];
	}

	session.queue.push({
		content,
		commandText,
		currentUserText,
		currentMessageDate,
		attachmentBudget,
	});
	void pumpQueue(session, bot, chatId);
}

// Need to import these from shared
import {
	buildInvokeMessages,
	maybeRunPendingTaskCheck,
	prepareSessionForIncomingTurn,
} from "../shared";
