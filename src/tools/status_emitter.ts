import type { OutboundChannel } from "../channels/outbound";
import { createLogger } from "../logger";

const log = createLogger("tools.status");

export type StatusEmitter = {
	emit(callerId: string, message: string): Promise<void>;
};

export const noopStatusEmitter: StatusEmitter = {
	emit: async (_callerId: string, _message: string): Promise<void> => {},
};

export type OutboundChannelWithStatus = OutboundChannel & {
	sendStatus(callerId: string, message: string): Promise<void>;
};

export function createStatusEmitter(
	outbound: OutboundChannel | undefined,
): StatusEmitter {
	if (!outbound || !("sendStatus" in outbound)) {
		return noopStatusEmitter;
	}
	const channelWithStatus = outbound as OutboundChannelWithStatus;
	return {
		emit: async (callerId: string, message: string): Promise<void> => {
			try {
				await channelWithStatus.sendStatus(callerId, message);
			} catch (err) {
				log.error("sendStatus failed", {
					callerId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
	};
}
