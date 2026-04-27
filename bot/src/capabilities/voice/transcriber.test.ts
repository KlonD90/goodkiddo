import { describe, expect, test } from "bun:test";
import {
	NoOpTranscriber,
	type Transcriber,
} from "./transcriber";

class StubTranscriber implements Transcriber {
	async transcribe(audioBytes: Uint8Array, mimeType: string): Promise<string> {
		return `${mimeType}:${audioBytes.length}`;
	}
}

describe("voice transcriber", () => {
	test("NoOpTranscriber throws when transcription is not configured", async () => {
		const transcriber = new NoOpTranscriber();

		expect(
			transcriber.transcribe(new Uint8Array([1, 2, 3]), "audio/ogg"),
		).rejects.toThrow(/Voice transcription not configured/i);
	});

	test("accepts implementations that satisfy the transcriber contract", async () => {
		const transcriber: Transcriber = new StubTranscriber();

		await expect(
			transcriber.transcribe(new Uint8Array([1, 2, 3]), "audio/ogg"),
		).resolves.toBe("audio/ogg:3");
	});
});
