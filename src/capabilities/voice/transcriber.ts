export interface Transcriber {
	transcribe(audioBytes: Uint8Array, mimeType: string): Promise<string>;
}

export class NoOpTranscriber implements Transcriber {
	async transcribe(_audioBytes: Uint8Array, _mimeType: string): Promise<string> {
		throw new Error("Voice transcription not configured");
	}
}
