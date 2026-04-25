import { Bot } from "grammy";
import type { AppConfig } from "../../config";
import type { Caller } from "../../permissions/types";
import type { PermissionsStore } from "../../permissions/store";
import type { ApprovalBroker, ApprovalRequest, ApprovalOutcome } from "../../permissions/approval";
import type { TimerStore } from "../../capabilities/timers/store";
import type { ChannelRunOptions } from "../types";
import type { TelegramAgentSession, PendingApproval } from "./types";
import { APPROVAL_TIMEOUT_MS } from "./types";
import { sendTelegramMessage } from "./outbound";
import { createTimerTools } from "../../capabilities/timers/tools";
import { computeNextRunAt } from "../../capabilities/timers/scheduler";
import { createChannelAgentSession } from "../shared";
import { fileDataToString } from "../../utils/filesystem";
import { resolveLocale } from "../../i18n/locale";
import { createLogger } from "../../logger";

const log = createLogger("telegram");

// --- Approval broker ---

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
				if (session.pendingApprovals.has(promptId)) {
					session.pendingApprovals.delete(promptId);
					const timeoutSeconds = Math.round(APPROVAL_TIMEOUT_MS / 1000);
					void sendTelegramMessage(
						this.bot,
						this.chatId,
						`Approval timed out after ${timeoutSeconds}s; denying ${request.toolName}.`,
					).catch((err) => {
						log.error("approval timeout notification failed", {
							chatId: this.chatId,
							promptId,
							error: err instanceof Error ? err.message : String(err),
						});
					});
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

			session.pendingApprovals.set(promptId, {
				request,
				resolve: wrappedResolve,
				timeout,
				promptId,
			});
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

// --- Session creation ---

export async function ensureTelegramSession(
	chatId: string,
	caller: Caller,
	config: AppConfig,
	db: InstanceType<typeof Bun.SQL>,
	dialect: "sqlite" | "postgres",
	store: PermissionsStore,
	bot: Bot,
	sessions: Map<string, TelegramAgentSession>,
	outbound: import("../outbound").OutboundChannel,
	webShare: ChannelRunOptions["webShare"],
	timerStore?: TimerStore,
	statusEmitter?: ReturnType<typeof import("../../tools/status_emitter").createStatusEmitter>,
	locale?: string,
): Promise<TelegramAgentSession> {
	const existing = sessions.get(chatId);
	if (existing) return existing;

	const broker = new TelegramApprovalBroker(bot, sessions, chatId, store);
	const baseThreadId = `telegram-${chatId}`;
	const readMdFile = async (path: string): Promise<string> => {
		const data = await session.workspace.readRaw(path);
		return fileDataToString(data);
	};
	const timerTools = timerStore
		? createTimerTools(timerStore, {
				computeNextRun: computeNextRunAt,
				readMdFile,
				callerId: caller.id,
				chatId,
			})
		: undefined;
	const session = await createChannelAgentSession(config, {
		db,
		dialect,
		caller,
		store,
		broker,
		threadId: baseThreadId,
		outbound,
		webShare,
		timerTools,
		statusEmitter,
		locale: locale as ReturnType<typeof resolveLocale>,
	});

	const telegramSession: TelegramAgentSession = {
		...session,
		running: false,
		queue: [],
		pendingApprovals: new Map(),
	};
	sessions.set(chatId, telegramSession);
	return telegramSession;
}

import { InlineKeyboard } from "grammy";
import { persistAlwaysRule } from "../../permissions/approval";
