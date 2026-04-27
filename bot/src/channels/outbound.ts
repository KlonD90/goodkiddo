export type OutboundSendResult = { ok: true } | { ok: false; error: string };

export interface OutboundSendFileArgs {
	callerId: string;
	path: string;
	bytes: Uint8Array;
	mimeType: string;
	caption?: string;
}

export interface OutboundChannel {
	sendFile(args: OutboundSendFileArgs): Promise<OutboundSendResult>;
	sendStatus(callerId: string, message: string): Promise<void>;
}
