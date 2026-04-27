import { describe, expect, test } from "bun:test";
import type { CheckpointSummary } from "./checkpoint_compaction";
import { deserializeCheckpointSummary } from "./checkpoint_compaction";
import {
	buildRuntimeContext,
	extractRecentTurns,
	renderCheckpointSummary,
	renderCompactionPromptContext,
} from "./runtime_context";
import type { ThreadMessage } from "./summarize";

const FULL_SUMMARY: CheckpointSummary = {
	current_goal: "Build payment integration",
	decisions: ["Use Stripe SDK v4", "Retry on 5xx"],
	constraints: ["PCI-DSS scope must not expand"],
	unfinished_work: ["webhook handler", "3DS2 flow"],
	pending_approvals: ["prod secret rotation"],
	important_artifacts: ["src/payments/stripe.ts"],
};

const makeMessages = (...pairs: Array<[string, string]>): ThreadMessage[] =>
	pairs.flatMap(([u, a]) => [
		{ role: "user" as const, content: u },
		{ role: "assistant" as const, content: a },
	]);

const TOOL_HEAVY_MESSAGES: ThreadMessage[] = [
	{ role: "user", content: "first" },
	{ role: "assistant", content: "first reply" },
	{ role: "user", content: "second" },
	{ role: "assistant", content: "thinking" },
	{ role: "tool", content: "tool payload" },
	{ role: "assistant", content: "second reply" },
	{ role: "user", content: "third" },
	{ role: "assistant", content: "third reply" },
];

// ---------------------------------------------------------------------------
// renderCompactionPromptContext
// ---------------------------------------------------------------------------

describe("renderCompactionPromptContext", () => {
	test("renders checkpoint summary as JSON data instead of chat messages", () => {
		const out = renderCompactionPromptContext({
			checkpoint: FULL_SUMMARY,
			recentTurns: makeMessages(["prev", "reply"]),
		});

		expect(out).toContain("Compacted Conversation Context");
		expect(out).toContain('"current_goal": "Build payment integration"');
		expect(out).toContain('"role": "user"');
		expect(out).toContain('"content": "prev"');
		expect(out).toContain("reference context only");
	});
});

// ---------------------------------------------------------------------------
// renderCheckpointSummary
// ---------------------------------------------------------------------------

describe("renderCheckpointSummary", () => {
	test("includes checkpoint header", () => {
		const out = renderCheckpointSummary(FULL_SUMMARY);
		expect(out).toContain("[Conversation Checkpoint]");
	});

	test("renders goal", () => {
		const out = renderCheckpointSummary(FULL_SUMMARY);
		expect(out).toContain("Goal: Build payment integration");
	});

	test("renders decisions", () => {
		const out = renderCheckpointSummary(FULL_SUMMARY);
		expect(out).toContain("Use Stripe SDK v4");
		expect(out).toContain("Retry on 5xx");
	});

	test("renders constraints", () => {
		const out = renderCheckpointSummary(FULL_SUMMARY);
		expect(out).toContain("PCI-DSS scope must not expand");
	});

	test("renders unfinished_work and pending_approvals under Unresolved", () => {
		const out = renderCheckpointSummary(FULL_SUMMARY);
		expect(out).toContain("Unresolved:");
		expect(out).toContain("webhook handler");
		expect(out).toContain("3DS2 flow");
		expect(out).toContain("prod secret rotation");
	});

	test("renders artifacts", () => {
		const out = renderCheckpointSummary(FULL_SUMMARY);
		expect(out).toContain("Artifacts: src/payments/stripe.ts");
	});

	test("omits empty sections", () => {
		const sparse: CheckpointSummary = {
			current_goal: "Just a goal",
			decisions: [],
			constraints: [],
			unfinished_work: [],
			pending_approvals: [],
			important_artifacts: [],
		};
		const out = renderCheckpointSummary(sparse);
		expect(out).not.toContain("Decisions:");
		expect(out).not.toContain("Constraints:");
		expect(out).not.toContain("Unresolved:");
		expect(out).not.toContain("Artifacts:");
		expect(out).toContain("Goal: Just a goal");
	});

	test("handles fully empty summary without error", () => {
		const empty: CheckpointSummary = {
			current_goal: "",
			decisions: [],
			constraints: [],
			unfinished_work: [],
			pending_approvals: [],
			important_artifacts: [],
		};
		const out = renderCheckpointSummary(empty);
		expect(out).toBe("[Conversation Checkpoint]");
	});
});

// ---------------------------------------------------------------------------
// extractRecentTurns
// ---------------------------------------------------------------------------

describe("extractRecentTurns", () => {
	test("returns empty array for empty messages", () => {
		expect(extractRecentTurns([], 2)).toEqual([]);
	});

	test("returns empty array when turns is 0", () => {
		const msgs = makeMessages(["hello", "hi"]);
		expect(extractRecentTurns(msgs, 0)).toEqual([]);
	});

	test("returns all messages when turns > available user messages", () => {
		const msgs = makeMessages(["hello", "hi"]);
		const result = extractRecentTurns(msgs, 5);
		expect(result).toEqual(msgs);
	});

	test("extracts last 1 turn from 3-turn history", () => {
		const msgs = makeMessages(
			["first", "first-reply"],
			["second", "second-reply"],
			["third", "third-reply"],
		);
		const result = extractRecentTurns(msgs, 1);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ role: "user", content: "third" });
		expect(result[1]).toMatchObject({
			role: "assistant",
			content: "third-reply",
		});
	});

	test("extracts last 2 turns from 4-turn history", () => {
		const msgs = makeMessages(
			["old1", "old1-reply"],
			["old2", "old2-reply"],
			["recent1", "recent1-reply"],
			["recent2", "recent2-reply"],
		);
		const result = extractRecentTurns(msgs, 2);
		expect(result).toHaveLength(4);
		expect(result[0]).toMatchObject({ role: "user", content: "recent1" });
		expect(result[2]).toMatchObject({ role: "user", content: "recent2" });
	});

	test("does not include messages before the cutoff", () => {
		const msgs = makeMessages(
			["early", "early-reply"],
			["middle", "middle-reply"],
			["latest", "latest-reply"],
		);
		const result = extractRecentTurns(msgs, 2);
		const contents = result.map((m) => m.content);
		expect(contents).not.toContain("early");
		expect(contents).not.toContain("early-reply");
		expect(contents).toContain("middle");
		expect(contents).toContain("latest");
	});

	test("handles messages with no assistant follow-up", () => {
		const msgs: ThreadMessage[] = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "first-reply" },
			{ role: "user", content: "second" },
			// no assistant reply yet
		];
		const result = extractRecentTurns(msgs, 1);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ role: "user", content: "second" });
	});

	test("keeps interleaved tool messages inside the retained turns", () => {
		expect(extractRecentTurns(TOOL_HEAVY_MESSAGES, 2)).toEqual([
			{ role: "user", content: "second" },
			{ role: "assistant", content: "thinking" },
			{ role: "tool", content: "tool payload" },
			{ role: "assistant", content: "second reply" },
			{ role: "user", content: "third" },
			{ role: "assistant", content: "third reply" },
		]);
	});
});

// ---------------------------------------------------------------------------
// buildRuntimeContext — no checkpoint
// ---------------------------------------------------------------------------

describe("buildRuntimeContext — no checkpoint", () => {
	test("returns all stored messages followed by current input", () => {
		const history = makeMessages(["q1", "a1"], ["q2", "a2"]);
		const ctx = buildRuntimeContext({
			checkpoint: null,
			allMessages: history,
			currentInput: "q3",
		});

		expect(ctx.hasCompaction).toBe(false);
		expect(ctx.messages).toHaveLength(history.length + 1);
		expect(ctx.messages[ctx.messages.length - 1]).toMatchObject({
			role: "user",
			content: "q3",
		});
	});

	test("does not mutate the original messages array", () => {
		const history = makeMessages(["q1", "a1"]);
		const original = [...history];
		buildRuntimeContext({
			checkpoint: null,
			allMessages: history,
			currentInput: "q2",
		});
		expect(history).toEqual(original);
	});

	test("works with empty stored history", () => {
		const ctx = buildRuntimeContext({
			checkpoint: null,
			allMessages: [],
			currentInput: "hello",
		});
		expect(ctx.messages).toHaveLength(1);
		expect(ctx.messages[0]).toMatchObject({ role: "user", content: "hello" });
		expect(ctx.hasCompaction).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildRuntimeContext — with checkpoint (compaction)
// ---------------------------------------------------------------------------

describe("buildRuntimeContext — with checkpoint", () => {
	test("sets hasCompaction to true", () => {
		const ctx = buildRuntimeContext({
			checkpoint: FULL_SUMMARY,
			allMessages: [],
			currentInput: "continue",
		});
		expect(ctx.hasCompaction).toBe(true);
	});

	test("first message is a system message containing the checkpoint summary", () => {
		const ctx = buildRuntimeContext({
			checkpoint: FULL_SUMMARY,
			allMessages: [],
			currentInput: "go",
		});
		expect(ctx.messages[0]).toMatchObject({ role: "system" });
		expect(ctx.messages[0]?.content).toContain("[Conversation Checkpoint]");
		expect(ctx.messages[0]?.content).toContain("Build payment integration");
	});

	test("last message is the current user input", () => {
		const ctx = buildRuntimeContext({
			checkpoint: FULL_SUMMARY,
			allMessages: makeMessages(["old", "old-reply"]),
			currentInput: "new question",
		});
		expect(ctx.messages[ctx.messages.length - 1]).toMatchObject({
			role: "user",
			content: "new question",
		});
	});

	test("does not replay the full stored history — only recent turns appear", () => {
		const history = makeMessages(
			["ancient1", "ancient1-reply"],
			["ancient2", "ancient2-reply"],
			["ancient3", "ancient3-reply"],
			["recent1", "recent1-reply"],
			["recent2", "recent2-reply"],
		);

		const ctx = buildRuntimeContext({
			checkpoint: FULL_SUMMARY,
			allMessages: history,
			currentInput: "new",
			recentTurnCount: 2,
		});

		const contents = ctx.messages.map((m) => m.content);
		expect(contents).not.toContain("ancient1");
		expect(contents).not.toContain("ancient2");
		expect(contents).not.toContain("ancient3");
		expect(contents).toContain("recent1");
		expect(contents).toContain("recent2");
	});

	test("message count is: 1 system + recentTurns*2 + 1 user", () => {
		const history = makeMessages(["a", "a-r"], ["b", "b-r"], ["c", "c-r"]);

		const ctx = buildRuntimeContext({
			checkpoint: FULL_SUMMARY,
			allMessages: history,
			currentInput: "d",
			recentTurnCount: 2,
		});

		// 1 system + 4 recent (2 turns × 2 messages) + 1 current = 6
		expect(ctx.messages).toHaveLength(6);
	});

	test("recentTurnCount defaults to 2", () => {
		const history = makeMessages(
			["t1", "r1"],
			["t2", "r2"],
			["t3", "r3"],
			["t4", "r4"],
		);

		const ctx = buildRuntimeContext({
			checkpoint: FULL_SUMMARY,
			allMessages: history,
			currentInput: "t5",
			// no recentTurnCount — should default to 2
		});

		// 1 system + 4 (2 turns) + 1 current = 6
		expect(ctx.messages).toHaveLength(6);
	});

	test("handles empty stored history — no crash", () => {
		const ctx = buildRuntimeContext({
			checkpoint: FULL_SUMMARY,
			allMessages: [],
			currentInput: "start fresh",
		});

		// 1 system + 0 recent + 1 current = 2
		expect(ctx.messages).toHaveLength(2);
		expect(ctx.messages[0]?.role).toBe("system");
		expect(ctx.messages[1]?.role).toBe("user");
	});

	test("stored history length is unchanged after calling buildRuntimeContext", () => {
		const history = makeMessages(["p1", "a1"], ["p2", "a2"], ["p3", "a3"]);
		const lengthBefore = history.length;

		buildRuntimeContext({
			checkpoint: FULL_SUMMARY,
			allMessages: history,
			currentInput: "p4",
		});

		expect(history).toHaveLength(lengthBefore);
	});

	test("treats oversized-attachment checkpoints the same as other compacted checkpoints", () => {
		const checkpointRecord = {
			sourceBoundary: "oversized_attachment" as const,
			summaryPayload: JSON.stringify(FULL_SUMMARY),
		};

		const ctx = buildRuntimeContext({
			checkpoint: deserializeCheckpointSummary(checkpointRecord.summaryPayload),
			allMessages: makeMessages(
				["older", "older-reply"],
				["recent", "recent-reply"],
			),
			currentInput: "process the attachment",
			recentTurnCount: 1,
		});

		expect(checkpointRecord.sourceBoundary).toBe("oversized_attachment");
		expect(ctx.messages).toEqual([
			{
				role: "system",
				content: renderCheckpointSummary(FULL_SUMMARY),
			},
			{ role: "user", content: "recent" },
			{ role: "assistant", content: "recent-reply" },
			{ role: "user", content: "process the attachment" },
		]);
		expect(ctx.hasCompaction).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Integration: stored history != model-facing working context
// ---------------------------------------------------------------------------

describe("stored history vs model-facing working context", () => {
	test("full history is reduced to the exact compacted shape", () => {
		const fullHistory = makeMessages(
			["t1", "r1"],
			["t2", "r2"],
			["t3", "r3"],
			["t4", "r4"],
			["t5", "r5"],
		);

		// Full history has 10 messages
		expect(fullHistory).toHaveLength(10);

		const ctx = buildRuntimeContext({
			checkpoint: FULL_SUMMARY,
			allMessages: fullHistory,
			currentInput: "t6",
			recentTurnCount: 2,
		});

		expect(ctx.messages).toEqual([
			{
				role: "system",
				content: renderCheckpointSummary(FULL_SUMMARY),
			},
			{ role: "user", content: "t4" },
			{ role: "assistant", content: "r4" },
			{ role: "user", content: "t5" },
			{ role: "assistant", content: "r5" },
			{ role: "user", content: "t6" },
		]);
		expect(ctx.hasCompaction).toBe(true);
	});

	test("without compaction, full history is preserved in runtime context", () => {
		const fullHistory = makeMessages(
			["t1", "r1"],
			["t2", "r2"],
			["t3", "r3"],
			["t4", "r4"],
			["t5", "r5"],
		);

		const ctx = buildRuntimeContext({
			checkpoint: null,
			allMessages: fullHistory,
			currentInput: "t6",
		});

		// Full 10 messages + 1 current = 11
		expect(ctx.messages).toHaveLength(fullHistory.length + 1);
		expect(ctx.hasCompaction).toBe(false);
	});
});
