import type { PdfExtractor } from "../capabilities/pdf/extractor";
import type { CapabilityRegistry } from "../capabilities/registry";
import type { RecentChatStore } from "../capabilities/fetch/recent_chat_store";
import type { SpreadsheetParser } from "../capabilities/spreadsheet/parser";
import type { SchedulerOptions } from "../capabilities/timers/scheduler";
import type { TimerStore } from "../capabilities/timers/store";
import type { Transcriber } from "../capabilities/voice/transcriber";
import type { AppConfig } from "../config";
import type { AccessStore } from "../server/access_store";
import type { AppEntrypoint } from "../types";

export interface WebShareRuntime {
	access: AccessStore;
	publicBaseUrl: string;
}

export interface ChannelRunOptions {
	db?: ReturnType<typeof import("../db/index").createDb>;
	dialect?: "sqlite" | "postgres";
	webShare?: WebShareRuntime;
	transcriber?: Transcriber;
	pdfExtractor?: PdfExtractor;
	spreadsheetParser?: SpreadsheetParser;
	capabilityRegistry?: CapabilityRegistry;
	recentChatStore?: RecentChatStore;
	telegramBot?: import("grammy").Bot;
	timerStore?: TimerStore;
	timerScheduler?: {
		start(store: TimerStore, options: SchedulerOptions): { stop(): void };
	};
}

export interface AppChannel {
	readonly entrypoint: AppEntrypoint;
	run(config: AppConfig, options?: ChannelRunOptions): Promise<void>;
}
