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

	test("extractTextFromContent reads nested content blocks", () => {
		expect(
			extractTextFromContent([
				{
					type: "tool_result",
					content: [{ type: "text", text: "nested" }],
				},
			]),
		).toBe("nested");
	});

	test("extractAgentReply returns the latest text reply", () => {
		expect(
			extractAgentReply({
				messages: [
					{ role: "user", content: "question" },
					{ role: "assistant", content: "older" },
					{ role: "assistant", content: [{ type: "text", text: "newer" }] },
				],
			}),
		).toBe("newer");
	});

	test("extractAgentReply ignores trailing user text", () => {
		expect(
			extractAgentReply({
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "real reply" }],
					},
					{ role: "user", content: [{ type: "text", text: "echo me" }] },
				],
			}),
		).toBe("real reply");
	});

	test("extractAgentReply falls back when no text exists", () => {
		expect(
			extractAgentReply({
				messages: [{ role: "assistant", content: [{ type: "image" }] }],
			}),
		).toBe("The agent completed the task but did not return a text response.");
	});
});
