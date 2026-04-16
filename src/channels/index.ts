import type { AppConfig } from "../config";
import type { AppEntrypoint } from "../types";
import { cliChannel } from "./cli";
import { telegramChannel } from "./telegram";
import type { AppChannel } from "./types";

export const channelRegistry: Record<AppEntrypoint, AppChannel> = {
	cli: cliChannel,
	telegram: telegramChannel,
};

export function getAppChannel(entrypoint: AppEntrypoint): AppChannel {
	return channelRegistry[entrypoint];
}

export async function runAppChannel(config: AppConfig): Promise<void> {
	await getAppChannel(config.appEntrypoint).run(config);
}

export type * from "./types";
