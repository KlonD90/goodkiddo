import type { AppConfig } from "../config";
import type { AccessStore } from "../server/access_store";
import type { AppEntrypoint } from "../types";

type SQL = InstanceType<typeof Bun.SQL>;

export interface WebShareRuntime {
	access: AccessStore;
	publicBaseUrl: string;
}

export interface ChannelRunOptions {
	db?: SQL;
	dialect?: "sqlite" | "postgres";
	webShare?: WebShareRuntime;
}

export interface AppChannel {
	readonly entrypoint: AppEntrypoint;
	run(config: AppConfig, options?: ChannelRunOptions): Promise<void>;
}
