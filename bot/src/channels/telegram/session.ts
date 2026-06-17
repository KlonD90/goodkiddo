import { Bot } from "grammy";
import { computeNextRunAt } from "../../capabilities/timers/scheduler";
import type { TimerStore } from "../../capabilities/timers/store";
import { createTimerTools } from "../../capabilities/timers/tools";
import type { AppConfig } from "../../config";
import type { AppPrisma } from "../../db/prisma";
import type { PermissionsStore } from "../../permissions/store";
import type { Caller } from "../../permissions/types";
import { resolveLocale } from "../../i18n/locale";
import { fileDataToString } from "../../utils/filesystem";
import { createChannelAgentSession } from "../shared";
import type { ChannelAgentSession } from "../shared";
import type { ChannelRunOptions } from "../types";
import type { StatusEmitter } from "../../tools/status_emitter";
import type { TelegramAgentSession } from "./types";

export function createContextAwareStatusEmitter(
	statusEmitter: StatusEmitter,
	sessionRef: { current?: ChannelAgentSession },
): StatusEmitter {
	return {
		emit: async (callerId: string, message: string): Promise<void> => {
			if (sessionRef.current?.currentTurnContext?.source === "scheduler") {
				return;
			}
			await statusEmitter.emit(callerId, message);
		},
	};
}

// --- Session creation ---

export async function ensureTelegramSession(
	chatId: string,
	caller: Caller,
	config: AppConfig,
	prisma: AppPrisma,
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
				defaultNotifyMode: config.timerNotifyModeDefault,
			})
		: undefined;

	// Deferred reference so the context-aware emitter can inspect the running
	// turn while tools call emit() mid-stream.
	const sessionRef: { current?: ChannelAgentSession } = {};
	const contextAwareStatusEmitter = statusEmitter
		? createContextAwareStatusEmitter(statusEmitter, sessionRef)
		: undefined;

	const session = await createChannelAgentSession(config, {
		prisma,
		caller,
		store,
		threadId: baseThreadId,
		outbound,
		webShare,
		timerTools,
		statusEmitter: contextAwareStatusEmitter,
		locale: locale as ReturnType<typeof resolveLocale>,
	});
	sessionRef.current = session;

	const telegramSession: TelegramAgentSession = {
		...session,
		running: false,
		queue: [],
	};
	sessions.set(chatId, telegramSession);
	return telegramSession;
}
