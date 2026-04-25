import { describe, expect, test } from "bun:test";
import {
	type AttachmentBudgetConfig,
	decideAttachmentBudget,
	estimateAttachmentTokens,
} from "./attachment_budget";
import type { CapabilityOutput } from "./types";

const baseConfig: AttachmentBudgetConfig = {
	maxContextWindowTokens: 100,
	reserveSummaryTokens: 10,
	reserveRecentTurnTokens: 10,
	reserveNextTurnTokens: 10,
};

function makeOutput(content: CapabilityOutput["content"]): CapabilityOutput {
	return {
		content,
		currentUserText: "current user text",
	};
}

describe("estimateAttachmentTokens", () => {
	test("estimates string content with the shared 1 token ~= 4 chars heuristic", () => {
		expect(estimateAttachmentTokens(makeOutput("abcdefghij"))).toBe(3);
	});

	test("sums only text parts for array content", () => {
		expect(
			estimateAttachmentTokens(
				makeOutput([
					{ type: "text", text: "abcd" },
					{
						type: "image",
						mimeType: "image/png",
						data: new Uint8Array([1, 2]),
					},
					{ type: "text", text: "abcdef" },
				]),
			),
		).toBe(3);
	});
});

describe("decideAttachmentBudget", () => {
	test("returns fit when attachment and runtime fit comfortably inside available budget", () => {
		expect(
			decideAttachmentBudget({
				attachmentTokens: 20,
				currentRuntimeTokens: 30,
				config: baseConfig,
			}),
		).toEqual({ kind: "fit" });
	});

	test("returns compact_then_inject when attachment can fit only after compaction", () => {
		expect(
			decideAttachmentBudget({
				attachmentTokens: 65,
				currentRuntimeTokens: 10,
				config: baseConfig,
			}),
		).toEqual({
			kind: "compact_then_inject",
			attachmentTokens: 65,
		});
	});

	test("returns reject when attachment exceeds the single-turn maximum by one token", () => {
		expect(
			decideAttachmentBudget({
				attachmentTokens: 91,
				currentRuntimeTokens: 0,
				config: baseConfig,
			}),
		).toEqual({
			kind: "reject",
			attachmentTokens: 91,
			maxTokens: 90,
		});
	});

	test("treats the comfortable-fit boundary as inclusive", () => {
		expect(
			decideAttachmentBudget({
				attachmentTokens: 50,
				currentRuntimeTokens: 20,
				config: baseConfig,
			}),
		).toEqual({ kind: "fit" });
	});

	test("treats the reject boundary as exclusive so the exact limit still compacts", () => {
		expect(
			decideAttachmentBudget({
				attachmentTokens: 90,
				currentRuntimeTokens: 1,
				config: baseConfig,
			}),
		).toEqual({
			kind: "compact_then_inject",
			attachmentTokens: 90,
		});
	});

	test("handles zero runtime tokens", () => {
		expect(
			decideAttachmentBudget({
				attachmentTokens: 70,
				currentRuntimeTokens: 0,
				config: baseConfig,
			}),
		).toEqual({ kind: "fit" });
	});
});
