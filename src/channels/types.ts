import type { AppConfig } from "../config";
import type { AccessStore } from "../server/access_store";
import type { AppEntrypoint } from "../types";

export interface WebShareRuntime {
	access: AccessStore;
	publicBaseUrl: string;
}

export interface ChannelRunOptions {
	webShare?: WebShareRuntime;
}

export interface AppChannel {
	readonly entrypoint: AppEntrypoint;
	run(config: AppConfig, options?: ChannelRunOptions): Promise<void>;
}
