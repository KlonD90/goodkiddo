import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import { ForcedCheckpointStore } from "../checkpoints/forced_checkpoint_store";
import { createDb } from "../db/index";
import type { CheckpointSummary } from "../memory/checkpoint_compaction";
import type { ThreadMessage } from "../memory/summarize";
import type { ChannelAgentSession } from "./shared";
import {
	buildInvokeMessages,
	extractAgentReply,
	extractTextFromContent,
	maybeAutoCompactAndSeed,
	maybeResumeCompactAndSeed,
	seedFromCheckpoint,
} from "./shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function createTempStore(): {
	store: ForcedCheckpointStore;
	close: () => Promise<void>;
} {
	const dir = mkdtempSync(join(tmpdir(), "shared-test-"));
	tempDirs.push(dir);
	const dbUrl = `sqlite://${join(dir, "test.sqlite")}`;
	const db = createDb(dbUrl);
	const store = new ForcedCheckpointStore(db);
	return { store, close: () => db.close() };
}

const SAMPLE_SUMMARY: CheckpointSummary = {
	current_goal: "Deploy the service",
	decisions: ["Use Docker", "Retry on 5xx"],
	constraints: ["PCI scope must not expand"],
	unfinished_work: ["webhook handler"],
	pending_approvals: [],
	important_artifacts: ["src/deploy.ts"],
};

function makeMessages(...pairs: Array<[string, string]>): ThreadMessage[] {
	return pairs.flatMap(([u, a]) => [
		{ role: "user" as const, content: u },
		{ role: "assistant" as const, content: a },
	]);
}

function makeToolHeavyTurns(): ThreadMessage[] {
	return [
		{ role: "user", content: "older question" },
		{ role: "assistant", content: "older answer" },
		{ role: "user", content: "recent question" },
		{ role: "assistant", content: "thinking" },
		{ role: "tool", content: "tool result" },
		{ role: "assistant", content: "recent answer" },
		{ role: "user", content: "latest question" },
		{ role: "assistant", content: "latest answer" },
	];
}

function stubSession(
	overrides?: Partial<ChannelAgentSession>,
): ChannelAgentSession {
	return {
		threadId: "test-thread",
		agent: {} as unknown as ChannelAgentSession["agent"],
		workspace: {} as unknown as BackendProtocol,
		model: {} as unknown as BaseChatModel,
		refreshAgent: async () => {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildInvokeMessages
// ---------------------------------------------------------------------------

describe("buildInvokeMessages — no pending seed", () => {
	test("returns just the current user message", () => {
		const session = stubSession();
		const result = buildInvokeMessages(session, {
			role: "user",
			content: "hello",
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ role: "user", content: "hello" });
	});

	test("passes multimodal content through unchanged", () => {
		const session = stubSession();
		const content = [{ type: "text", text: "hi" }, { type: "image" }];
		const result = buildInvokeMessages(session, { role: "user", content });
		expect(result).toHaveLength(1);
		expect(result[0]?.content).toBe(content);
	});
});

describe("buildInvokeMessages — with pending seed", () => {
	test("prepends checkpoint system message and recent turns", () => {
		const recentTurns = makeMessages(["prev-q", "prev-a"]);
		const session = stubSession({
			pendingCompactionSeed: { summary: SAMPLE_SUMMARY, recentTurns },
		});

		const result = buildInvokeMessages(session, {
			role: "user",
			content: "next question",
		});

		// [system checkpoint] + [user prev-q, assistant prev-a] + [user next-q] = 4
		expect(result).toHaveLength(4);
		expect(result[0]).toMatchObject({ role: "system" });
		expect(result[0]?.content).toContain("[Conversation Checkpoint]");
		expect(result[0]?.content).toContain("Deploy the service");
		expect(result[1]).toMatchObject({ role: "user", content: "prev-q" });
		expect(result[2]).toMatchObject({ role: "assistant", content: "prev-a" });
		expect(result[3]).toMatchObject({ role: "user", content: "next question" });
	});

	test("clears pendingCompactionSeed after use", () => {
		const session = stubSession({
			pendingCompactionSeed: {
				summary: SAMPLE_SUMMARY,
				recentTurns: [],
			},
		});

		buildInvokeMessages(session, { role: "user", content: "first" });
		expect(session.pendingCompactionSeed).toBeUndefined();
	});

	test("subsequent call (seed cleared) returns only current user message", () => {
		const session = stubSession({
			pendingCompactionSeed: { summary: SAMPLE_SUMMARY, recentTurns: [] },
		});

		buildInvokeMessages(session, { role: "user", content: "first" });
		const second = buildInvokeMessages(session, {
			role: "user",
			content: "second",
		});
		expect(second).toHaveLength(1);
		expect(second[0]).toMatchObject({ role: "user", content: "second" });
	});

	test("preserves multimodal content as the final message", () => {
		const session = stubSession({
			pendingCompactionSeed: { summary: SAMPLE_SUMMARY, recentTurns: [] },
		});
		const content = [{ type: "image" }, { type: "text", text: "with image" }];
		const result = buildInvokeMessages(session, { role: "user", content });

		// Last message must be the original multimodal message
		const last = result[result.length - 1];
		expect(last?.content).toBe(content);
	});

	test("empty recentTurns: only system + current user", () => {
		const session = stubSession({
			pendingCompactionSeed: { summary: SAMPLE_SUMMARY, recentTurns: [] },
		});

		const result = buildInvokeMessages(session, {
			role: "user",
			content: "go",
		});
		expect(result).toHaveLength(2);
		expect(result[0]?.role).toBe("system");
		expect(result[1]).toMatchObject({ role: "user", content: "go" });
	});
});

// ---------------------------------------------------------------------------
// seedFromCheckpoint
// ---------------------------------------------------------------------------

describe("seedFromCheckpoint", () => {
	test("sets pendingCompactionSeed from a JSON checkpoint payload", () => {
		const session = stubSession();
		const payload = JSON.stringify(SAMPLE_SUMMARY);
		const messages = makeMessages(["q1", "a1"], ["q2", "a2"]);

		seedFromCheckpoint(session, payload, messages);

		expect(session.pendingCompactionSeed).toBeDefined();
		expect(session.pendingCompactionSeed?.summary.current_goal).toBe(
			"Deploy the service",
		);
		// extractRecentTurns(messages, 2) = last 2 turns = all 4 messages here
		expect(session.pendingCompactionSeed?.recentTurns).toHaveLength(4);
	});

	test("empty messages result in empty recentTurns", () => {
		const session = stubSession();
		seedFromCheckpoint(session, JSON.stringify(SAMPLE_SUMMARY), []);
		expect(session.pendingCompactionSeed?.recentTurns).toHaveLength(0);
	});

	test("extracts only last 2 turns from a long history", () => {
		const session = stubSession();
		const messages = makeMessages(
			["old1", "r1"],
			["old2", "r2"],
			["old3", "r3"],
			["recent1", "r4"],
			["recent2", "r5"],
		);
		seedFromCheckpoint(session, JSON.stringify(SAMPLE_SUMMARY), messages);

		const turns = session.pendingCompactionSeed?.recentTurns;
		if (!turns) throw new Error("Expected pending compaction seed");
		// 2 turns = 4 messages
		expect(turns).toHaveLength(4);
		expect(turns[0]).toMatchObject({ content: "recent1" });
	});

	test("preserves tool messages inside the last two turns", () => {
		const session = stubSession();
		const messages = makeToolHeavyTurns();

		seedFromCheckpoint(session, JSON.stringify(SAMPLE_SUMMARY), messages);

		expect(session.pendingCompactionSeed?.recentTurns).toEqual([
			{ role: "user", content: "recent question" },
			{ role: "assistant", content: "thinking" },
			{ role: "tool", content: "tool result" },
			{ role: "assistant", content: "recent answer" },
			{ role: "user", content: "latest question" },
			{ role: "assistant", content: "latest answer" },
		]);
	});
});

// ---------------------------------------------------------------------------
// maybeAutoCompactAndSeed
// ---------------------------------------------------------------------------

describe("maybeAutoCompactAndSeed — no compactionConfig", () => {
	test("returns false and does not modify session", async () => {
		const session = stubSession();
		const result = await maybeAutoCompactAndSeed(
			session,
			[],
			"next",
			() => "new-thread",
		);
		expect(result).toBe(false);
		expect(session.pendingCompactionSeed).toBeUndefined();
		expect(session.threadId).toBe("test-thread");
	});
});

describe("maybeAutoCompactAndSeed — threshold not exceeded", () => {
	test("returns false when below limits", async () => {
		const { store, close } = createTempStore();
		const model = {
			async invoke() {
				return { content: JSON.stringify(SAMPLE_SUMMARY) };
			},
		} as unknown as BaseChatModel;

		const session = stubSession({
			model,
			compactionConfig: {
				caller: "user-1",
				store,
				thresholds: { messageLimit: 100, tokenBudget: 1_000_000 },
			},
		});
		const messages = makeMessages(["q1", "a1"]); // 2 messages, well below 100

		const result = await maybeAutoCompactAndSeed(
			session,
			messages,
			"next",
			() => "new",
		);
		expect(result).toBe(false);
		expect(session.threadId).toBe("test-thread");
		expect(session.pendingCompactionSeed).toBeUndefined();
		await close();
	});
});

describe("maybeAutoCompactAndSeed — threshold exceeded", () => {
	test("returns true, rotates thread, and sets pending seed", async () => {
		const { store, close } = createTempStore();
		let minted = "";
		const model = {
			async invoke() {
				return { content: JSON.stringify(SAMPLE_SUMMARY) };
			},
		} as unknown as BaseChatModel;

		const session = stubSession({
			model,
			compactionConfig: {
				caller: "user-2",
				store,
				thresholds: { messageLimit: 2, tokenBudget: 1_000_000 },
			},
		});
		const messages = makeMessages(["q1", "a1"]); // exactly 2 messages → hits messageLimit:2

		const result = await maybeAutoCompactAndSeed(
			session,
			messages,
			"next turn",
			() => {
				minted = "new-thread-1";
				return minted;
			},
		);

		expect(result).toBe(true);
		expect(session.threadId).toBe("new-thread-1");
		expect(session.pendingCompactionSeed).toBeDefined();
		expect(session.pendingCompactionSeed?.summary.current_goal).toBe(
			"Deploy the service",
		);
		// recentTurns = last 2 turns = all 2 messages
		expect(session.pendingCompactionSeed?.recentTurns).toHaveLength(2);

		// checkpoint was persisted in store under old thread
		const checkpoint = await store.readLatest("user-2", "test-thread");
		expect(checkpoint).not.toBeNull();
		expect(checkpoint?.sourceBoundary).toBe("message_limit");
		await close();
	});

	test("long conversation: next buildInvokeMessages uses seeded context", async () => {
		const { store, close } = createTempStore();
		const model = {
			async invoke() {
				return { content: JSON.stringify(SAMPLE_SUMMARY) };
			},
		} as unknown as BaseChatModel;

		const session = stubSession({
			model,
			compactionConfig: {
				caller: "user-3",
				store,
				thresholds: { messageLimit: 2, tokenBudget: 1_000_000 },
			},
		});
		const messages = makeMessages(["q1", "a1"]); // triggers at 2

		await maybeAutoCompactAndSeed(
			session,
			messages,
			"after compaction",
			() => "new-thread-x",
		);

		// Now buildInvokeMessages should use the seed
		const invokeMessages = buildInvokeMessages(session, {
			role: "user",
			content: "after compaction",
		});

		// [system checkpoint, user q1, assistant a1, user "after compaction"] = 4
		expect(invokeMessages).toHaveLength(4);
		expect(invokeMessages[0]?.role).toBe("system");
		expect(invokeMessages[0]?.content).toContain("Deploy the service");
		expect(invokeMessages[invokeMessages.length - 1]).toMatchObject({
			role: "user",
			content: "after compaction",
		});
		await close();
	});

	test("threshold compacts when the pending user turn is what crosses the limit", async () => {
		const { store, close } = createTempStore();
		const model = {
			async invoke() {
				return { content: JSON.stringify(SAMPLE_SUMMARY) };
			},
		} as unknown as BaseChatModel;

		const session = stubSession({
			model,
			compactionConfig: {
				caller: "user-4",
				store,
				thresholds: { messageLimit: 3, tokenBudget: 1_000_000 },
			},
		});
		const messages = makeMessages(["q1", "a1"]);

		const result = await maybeAutoCompactAndSeed(
			session,
			messages,
			"user turn that crosses the limit",
			() => "new-thread-threshold",
		);

		expect(result).toBe(true);
		expect(session.threadId).toBe("new-thread-threshold");

		const checkpoint = await store.readLatest("user-4", "test-thread");
		expect(checkpoint?.sourceBoundary).toBe("message_limit");
		await close();
	});
});

describe("maybeResumeCompactAndSeed", () => {
	test("compacts and rotates on the first turn after session resume", async () => {
		const { store, close } = createTempStore();
		const persistedThreadIds: string[] = [];
		const model = {
			async invoke() {
				return { content: JSON.stringify(SAMPLE_SUMMARY) };
			},
		} as unknown as BaseChatModel;
		const messages = makeMessages(["q1", "a1"], ["q2", "a2"]);
		const session = stubSession({
			model,
			needsResumeCompaction: true,
			persistThreadId: async (threadId: string) => {
				persistedThreadIds.push(threadId);
			},
			compactionConfig: {
				caller: "resume-user",
				store,
			},
		});

		const result = await maybeResumeCompactAndSeed(
			session,
			messages,
			() => "resumed-thread",
		);

		expect(result).toBe(true);
		expect(session.threadId).toBe("resumed-thread");
		expect(session.needsResumeCompaction).toBe(false);
		expect(session.pendingCompactionSeed).toBeDefined();
		expect(persistedThreadIds).toEqual(["resumed-thread"]);

		const checkpoint = await store.readLatest("resume-user", "test-thread");
		expect(checkpoint?.sourceBoundary).toBe("session_resume");
		await close();
	});

	test("does nothing when there is no stored history to compact", async () => {
		const { store, close } = createTempStore();
		const session = stubSession({
			needsResumeCompaction: true,
			compactionConfig: {
				caller: "resume-user",
				store,
			},
		});

		const result = await maybeResumeCompactAndSeed(session, [], () => "unused");

		expect(result).toBe(false);
		expect(session.threadId).toBe("test-thread");
		expect(session.pendingCompactionSeed).toBeUndefined();
		expect(session.needsResumeCompaction).toBe(false);
		await close();
	});
});

// ---------------------------------------------------------------------------
// existing extractTextFromContent / extractAgentReply tests
// ---------------------------------------------------------------------------

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
