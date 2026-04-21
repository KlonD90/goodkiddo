import type { AppConfig } from "../config";
import type { AccessStore } from "../server/access_store";
import type { AppEntrypoint } from "../types";
import type { PdfExtractor } from "../capabilities/pdf/extractor";
import type { SpreadsheetParser } from "../capabilities/spreadsheet/parser";
import type { Transcriber } from "../capabilities/voice/transcriber";
import type { TimerStore } from "../capabilities/timers/store";
import type { SchedulerOptions } from "../capabilities/timers/scheduler";

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
	timerStore?: TimerStore;
	timerScheduler?: {
		start(store: TimerStore, options: SchedulerOptions): { stop(): void };
	};
}

export interface AppChannel {
	readonly entrypoint: AppEntrypoint;
	run(config: AppConfig, options?: ChannelRunOptions): Promise<void>;
}
