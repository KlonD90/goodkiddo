import { describe, expect, test } from "bun:test";
import { extractAgentReply, extractTextFromContent } from "./shared";

describe("channel shared helpers", () => {
	test("extractTextFromContent returns plain strings unchanged", () => {
		expect(extractTextFromContent("hello")).toBe("hello");
	});

	test("extractTextFromContent joins text blocks and ignores non-text blocks", () => {
		expect(
			extractTextFromContent([
				{ type: "text", text: "first" },
				{ type: "image", image_url: "ignored" },
				{ type: "text", text: "second" },
			]),
		).toBe("first\nsecond");
	});

	test("extractAgentReply returns the latest text reply", () => {
		expect(
			extractAgentReply({
				messages: [
					{ content: "older" },
					{ content: [{ type: "text", text: "newer" }] },
				],
			}),
		).toBe("newer");
	});

	test("extractAgentReply falls back when no text exists", () => {
		expect(extractAgentReply({ messages: [{ content: [{ type: "image" }] }] })).toBe(
			"The agent completed the task but did not return a text response.",
		);
	});
});
