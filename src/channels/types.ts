import type { AppConfig } from "../config";
import type { AccessStore } from "../server/access_store";
import type { AppEntrypoint } from "../types";
import type { PdfExtractor } from "../capabilities/pdf/extractor";
import type { SpreadsheetParser } from "../capabilities/spreadsheet/parser";
import type { Transcriber } from "../capabilities/voice/transcriber";
import { createTimerTools } from "../capabilities/timers/tools";

type SQL = InstanceType<typeof Bun.SQL>;
type TimerTools = ReturnType<typeof createTimerTools>;

export interface WebShareRuntime {
	access: AccessStore;
	publicBaseUrl: string;
}

export interface ChannelRunOptions {
	db?: SQL;
	dialect?: "sqlite" | "postgres";
	webShare?: WebShareRuntime;
	transcriber?: Transcriber;
	pdfExtractor?: PdfExtractor;
	spreadsheetParser?: SpreadsheetParser;
	timerTools?: TimerTools;
	timerScheduler?: {
		start(): { stop(): void };
	};
}

export interface AppChannel {
	readonly entrypoint: AppEntrypoint;
	run(config: AppConfig, options?: ChannelRunOptions): Promise<void>;
}
