import { describe, expect, test } from "bun:test";
import { buildVoiceContent } from "./content";

describe("buildVoiceContent", () => {
	test("formats the transcript with the expected prefix", () => {
		expect(buildVoiceContent("hello world")).toBe("_Transcribed: hello world_");
	});

	test("appends a trimmed caption after the transcript", () => {
		expect(buildVoiceContent("hello world", "  follow-up context  ")).toBe(
			"_Transcribed: hello world_\n\nfollow-up context",
		);
	});

	test("omits blank captions", () => {
		expect(buildVoiceContent("hello world", "   ")).toBe(
			"_Transcribed: hello world_",
		);
	});
});
