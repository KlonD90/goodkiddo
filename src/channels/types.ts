import type { AppConfig } from "../config";
import type { AppEntrypoint } from "../types";

export interface AppChannel {
	readonly entrypoint: AppEntrypoint;
	run(config: AppConfig): Promise<void>;
}
