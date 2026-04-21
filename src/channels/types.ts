import type { AppConfig } from "../config";
import type { AccessStore } from "../server/access_store";
import type { AppEntrypoint } from "../types";
import type { PdfExtractor } from "../capabilities/pdf/extractor";
import type { Transcriber } from "../capabilities/voice/transcriber";

type SQL = InstanceType<typeof Bun.SQL>;

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
}

export interface AppChannel {
	readonly entrypoint: AppEntrypoint;
	run(config: AppConfig, options?: ChannelRunOptions): Promise<void>;
}
