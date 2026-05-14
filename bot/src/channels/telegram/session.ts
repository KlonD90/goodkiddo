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
import type { ChannelRunOptions } from "../types";
import type { TelegramAgentSession } from "./types";

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
			})
		: undefined;
	const session = await createChannelAgentSession(config, {
		prisma,
		caller,
		store,
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
	};
	sessions.set(chatId, telegramSession);
	return telegramSession;
}
