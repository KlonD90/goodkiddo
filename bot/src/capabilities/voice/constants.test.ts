import { describe, expect, test } from "bun:test";
import { VOICE_MAX_BYTES, VOICE_MIME_TYPE } from "./constants";

describe("voice constants", () => {
	test("define the supported Telegram voice constraints", () => {
		expect(VOICE_MAX_BYTES).toBe(1_048_576);
		expect(VOICE_MIME_TYPE).toBe("audio/ogg");
	});
});
