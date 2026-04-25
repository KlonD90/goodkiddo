import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createDb } from "../db";
import type { ThreadMessage } from "../memory/summarize";
import type { CompactionContext } from "./compaction_trigger";
import {
	countMeaningfulCompactionChars,
	DEFAULT_MIN_COMPACTION_CONTENT_CHARS,
	DEFAULT_MESSAGE_LIMIT,
	DEFAULT_TOKEN_BUDGET,
	estimateTokens,
	maybeCompactByThresholds,
	runCompaction,
	shouldCompactByMessageLimit,
	shouldCompactByMinimumContent,
	shouldCompactByTokenBudget,
	triggerOnOversizedAttachment,
	triggerOnSessionResume,
} from "./compaction_trigger";
import { ForcedCheckpointStore } from "./forced_checkpoint_store";

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
	const dir = mkdtempSync(join(tmpdir(), "compaction-trigger-"));
	tempDirs.push(dir);
	const dbUrl = `sqlite://${join(dir, "test.sqlite")}`;
	const db = createDb(dbUrl);
	const store = new ForcedCheckpointStore(db);
	return { store, close: () => db.close() };
}

function createStubModel(response: object): BaseChatModel {
	return {
		async invoke() {
			return { content: JSON.stringify(response) };
		},
	} as unknown as BaseChatModel;
}

function makeMessages(count: number, contentPerMessage = "x"): ThreadMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		role: (i % 2 === 0 ? "user" : "assistant") as ThreadMessage["role"],
		content: contentPerMessage,
	}));
}

const MEANINGFUL_CONTENT = "meaningful context ".repeat(1_400);

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------
describe("estimateTokens", () => {
	test("returns 0 for empty message list", () => {
		expect(estimateTokens([])).toBe(0);
	});

	test("estimates tokens as ceil(chars / 4) per message", () => {
		const messages: ThreadMessage[] = [
			{ role: "user", content: "abcd" }, // 4 chars → 1 token
			{ role: "assistant", content: "abcde" }, // 5 chars → 2 tokens
		];
		expect(estimateTokens(messages)).toBe(3);
	});

	test("sums over all messages", () => {
		const msgs = makeMessages(10, "xxxx"); // 4 chars each → 1 token each → 10 total
		expect(estimateTokens(msgs)).toBe(10);
	});
});

// ---------------------------------------------------------------------------
// shouldCompactByMessageLimit
// ---------------------------------------------------------------------------
describe("shouldCompactByMessageLimit", () => {
	test("returns false when count is below limit", () => {
		expect(shouldCompactByMessageLimit(makeMessages(5), 10)).toBe(false);
	});

	test("returns true when count exactly equals limit", () => {
		expect(shouldCompactByMessageLimit(makeMessages(10), 10)).toBe(true);
	});

	test("returns true when count exceeds limit", () => {
		expect(shouldCompactByMessageLimit(makeMessages(15), 10)).toBe(true);
	});

	test("returns false for empty messages list", () => {
		expect(shouldCompactByMessageLimit([], 1)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// shouldCompactByTokenBudget
// ---------------------------------------------------------------------------
describe("shouldCompactByTokenBudget", () => {
	test("returns false when estimated tokens are below budget", () => {
		// 5 messages × 4 chars → 5 tokens; budget 10
		expect(shouldCompactByTokenBudget(makeMessages(5, "xxxx"), 10)).toBe(false);
	});

	test("returns true when estimated tokens exactly reach budget", () => {
		// 10 messages × 4 chars → 10 tokens; budget 10
		expect(shouldCompactByTokenBudget(makeMessages(10, "xxxx"), 10)).toBe(true);
	});

	test("returns true when estimated tokens exceed budget", () => {
		// 20 messages × 4 chars → 20 tokens; budget 10
		expect(shouldCompactByTokenBudget(makeMessages(20, "xxxx"), 10)).toBe(true);
	});
});

describe("shouldCompactByMinimumContent", () => {
	test("returns false for empty messages", () => {
		expect(shouldCompactByMinimumContent([])).toBe(false);
		expect(countMeaningfulCompactionChars([])).toBe(0);
	});

	test("returns false for whitespace-only messages", () => {
		const messages = makeMessages(3, "   \n\t ");
		expect(shouldCompactByMinimumContent(messages)).toBe(false);
		expect(countMeaningfulCompactionChars(messages)).toBe(0);
	});

	test("returns false below the minimum character threshold", () => {
		expect(
			shouldCompactByMinimumContent([
				{ role: "user", content: "short" },
			]),
		).toBe(false);
	});

	test("returns true at the minimum character threshold", () => {
		expect(
			shouldCompactByMinimumContent([
				{
					role: "user",
					content: "x".repeat(DEFAULT_MIN_COMPACTION_CONTENT_CHARS),
				},
			]),
		).toBe(true);
	});

	test("returns true above the minimum character threshold", () => {
		expect(
			shouldCompactByMinimumContent([
				{ role: "user", content: MEANINGFUL_CONTENT },
			]),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// runCompaction
// ---------------------------------------------------------------------------
describe("runCompaction", () => {
	test("creates a checkpoint record with the correct boundary and caller/thread", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({
			current_goal: "test goal",
			decisions: [],
			constraints: [],
			unfinished_work: [],
			pending_approvals: [],
			important_artifacts: [],
		});
		const ctx: CompactionContext = {
			caller: "user-1",
			threadId: "thread-a",
			messages: makeMessages(3, MEANINGFUL_CONTENT),
			model,
			store,
		};

		const record = await runCompaction(ctx, "new_thread");
		expect(record).not.toBeNull();
		if (!record) throw new Error("Expected checkpoint record");
		expect(record.caller).toBe("user-1");
		expect(record.threadId).toBe("thread-a");
		expect(record.sourceBoundary).toBe("new_thread");
		expect(record.summaryPayload).toBeTruthy();
		expect(JSON.parse(record.summaryPayload).current_goal).toBe("test goal");

		const latest = await store.readLatest("user-1", "thread-a");
		expect(latest?.id).toBe(record.id);

		await close();
	});

	test("creates checkpoint with token_limit boundary", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({
			current_goal: "token boundary",
			decisions: [],
			constraints: [],
			unfinished_work: [],
			pending_approvals: [],
			important_artifacts: [],
		});
		const ctx: CompactionContext = {
			caller: "user-2",
			threadId: "thread-b",
			messages: makeMessages(2, MEANINGFUL_CONTENT),
			model,
			store,
		};

		const record = await runCompaction(ctx, "token_limit");
		expect(record?.sourceBoundary).toBe("token_limit");
		await close();
	});

	test("returns null and creates no checkpoint for trivial content", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({
			current_goal: "should not be called",
		});
		const ctx: CompactionContext = {
			caller: "user-trivial",
			threadId: "thread-trivial",
			messages: makeMessages(10, "x"),
			model,
			store,
		};

		const record = await runCompaction(ctx, "new_thread");

		expect(record).toBeNull();
		expect(await store.readLatest("user-trivial", "thread-trivial")).toBeNull();
		await close();
	});
});

// ---------------------------------------------------------------------------
// maybeCompactByThresholds
// ---------------------------------------------------------------------------
describe("maybeCompactByThresholds", () => {
	test("returns null when both thresholds are not exceeded", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({ current_goal: "" });
		const ctx: CompactionContext = {
			caller: "user-3",
			threadId: "thread-c",
			messages: makeMessages(5, "x"), // 5 messages, ~2 tokens total
			model,
			store,
		};

		const result = await maybeCompactByThresholds(ctx, {
			messageLimit: 10,
			tokenBudget: 100,
		});
		expect(result).toBeNull();

		const latest = await store.readLatest("user-3", "thread-c");
		expect(latest).toBeNull();
		await close();
	});

	test("fires message_limit compaction when count reaches limit", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({ current_goal: "goal" });
		const ctx: CompactionContext = {
			caller: "user-4",
			threadId: "thread-d",
			messages: makeMessages(10, MEANINGFUL_CONTENT),
			model,
			store,
		};

		const result = await maybeCompactByThresholds(ctx, {
			messageLimit: 10,
			tokenBudget: 100_000,
		});
		expect(result).not.toBeNull();
		expect(result?.sourceBoundary).toBe("message_limit");
		await close();
	});

	test("uses the pending user turn when evaluating thresholds", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({ current_goal: "goal" });
		const ctx: CompactionContext = {
			caller: "user-4b",
			threadId: "thread-d2",
			messages: makeMessages(2, MEANINGFUL_CONTENT),
			pendingMessage: { role: "user", content: "incoming" },
			model,
			store,
		};

		const result = await maybeCompactByThresholds(ctx, {
			messageLimit: 3,
			tokenBudget: 100_000,
		});
		expect(result?.sourceBoundary).toBe("message_limit");
		await close();
	});

	test("fires token_limit compaction when token budget is reached", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({ current_goal: "goal" });
		// 5 messages × 4 chars → 5 tokens; budget = 5 (exact match triggers)
		const ctx: CompactionContext = {
			caller: "user-5",
			threadId: "thread-e",
			messages: makeMessages(5, MEANINGFUL_CONTENT),
			model,
			store,
		};

		const result = await maybeCompactByThresholds(ctx, {
			messageLimit: 1000, // well above count
			tokenBudget: 5,
		});
		expect(result).not.toBeNull();
		expect(result?.sourceBoundary).toBe("token_limit");
		await close();
	});

	test("message_limit takes priority over token_limit when both exceeded", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({ current_goal: "goal" });
		const ctx: CompactionContext = {
			caller: "user-6",
			threadId: "thread-f",
			messages: makeMessages(10, MEANINGFUL_CONTENT), // exceeds both limits below
			model,
			store,
		};

		const result = await maybeCompactByThresholds(ctx, {
			messageLimit: 5, // exceeded
			tokenBudget: 5, // also exceeded
		});
		expect(result?.sourceBoundary).toBe("message_limit");
		await close();
	});

	test("uses default thresholds when none provided", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({ current_goal: "goal" });
		// Create exactly DEFAULT_MESSAGE_LIMIT messages to trigger message_limit
		const ctx: CompactionContext = {
			caller: "user-7",
			threadId: "thread-g",
			messages: makeMessages(DEFAULT_MESSAGE_LIMIT, MEANINGFUL_CONTENT),
			model,
			store,
		};

		const result = await maybeCompactByThresholds(ctx);
		expect(result?.sourceBoundary).toBe("message_limit");
		await close();
	});

	test("default token budget fires for large messages", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({ current_goal: "large" });
		// Produce messages with enough chars to exceed DEFAULT_TOKEN_BUDGET
		// with the same rough 1 token ≈ 4 chars estimate used in production.
		const bigContent = "x".repeat(DEFAULT_TOKEN_BUDGET * 4);
		const ctx: CompactionContext = {
			caller: "user-8",
			threadId: "thread-h",
			messages: [{ role: "user", content: bigContent }],
			model,
			store,
		};

		const result = await maybeCompactByThresholds(ctx, {
			messageLimit: DEFAULT_MESSAGE_LIMIT, // not exceeded (only 1 message)
			tokenBudget: DEFAULT_TOKEN_BUDGET,
		});
		expect(result?.sourceBoundary).toBe("token_limit");
		await close();
	});

	test("does not compact when thresholds are exceeded but prior content is trivial", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({ current_goal: "trivial" });
		const ctx: CompactionContext = {
			caller: "user-tiny",
			threadId: "thread-tiny",
			messages: makeMessages(10, "x"),
			model,
			store,
		};

		const result = await maybeCompactByThresholds(ctx, {
			messageLimit: 2,
			tokenBudget: 1,
		});

		expect(result).toBeNull();
		expect(await store.readLatest("user-tiny", "thread-tiny")).toBeNull();
		await close();
	});
});

// ---------------------------------------------------------------------------
// triggerOnSessionResume
// ---------------------------------------------------------------------------
describe("triggerOnSessionResume", () => {
	test("creates a checkpoint with session_resume boundary", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({ current_goal: "resumed" });
		const ctx: CompactionContext = {
			caller: "user-9",
			threadId: "thread-i",
			messages: makeMessages(2, MEANINGFUL_CONTENT),
			model,
			store,
		};

		const record = await triggerOnSessionResume(ctx);
		expect(record?.sourceBoundary).toBe("session_resume");
		expect(record?.caller).toBe("user-9");
		expect(record?.threadId).toBe("thread-i");

		const latest = await store.readLatest("user-9", "thread-i");
		expect(latest?.id).toBe(record?.id);
		await close();
	});
});

describe("triggerOnOversizedAttachment", () => {
	test("creates a checkpoint with oversized_attachment boundary", async () => {
		const { store, close } = createTempStore();
		const model = createStubModel({ current_goal: "make room for file" });
		const ctx: CompactionContext = {
			caller: "user-10",
			threadId: "thread-j",
			messages: makeMessages(2, MEANINGFUL_CONTENT),
			model,
			store,
		};

		const record = await triggerOnOversizedAttachment(ctx);
		expect(record?.sourceBoundary).toBe("oversized_attachment");

		const latest = await store.readLatest("user-10", "thread-j");
		expect(latest?.id).toBe(record?.id);
		await close();
	});
});
