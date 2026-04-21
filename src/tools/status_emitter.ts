import type { OutboundChannel } from "../channels/outbound";

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
			} catch {
				// Status emission failures must never propagate to the tool caller
			}
		},
	};
}
