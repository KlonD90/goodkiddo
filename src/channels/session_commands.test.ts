import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import { SqliteStateBackend } from "../backends";
import { ForcedCheckpointStore } from "../checkpoints/forced_checkpoint_store";
import { createDb, detectDialect } from "../db";
import {
	maybeHandleSessionCommand,
	type SessionCommandContext,
} from "./session_commands";
import type { ChannelAgentSession } from "./shared";

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
	const dir = mkdtempSync(join(tmpdir(), "session-commands-"));
	tempDirs.push(dir);
	const dbUrl = `sqlite://${join(dir, "test.sqlite")}`;
	const db = createDb(dbUrl);
	const store = new ForcedCheckpointStore(db);
	return { store, close: () => db.close() };
}

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

function createStubModel(summaryResponse = "- done"): BaseChatModel {
	return {
		async invoke(messages: Array<{ role: string; content: string }>) {
			const systemPrompt = messages[0]?.content ?? "";
			if (systemPrompt.includes("compacted into a checkpoint")) {
				return {
					content: JSON.stringify({
						current_goal: "test goal",
						decisions: [],
						constraints: [],
						unfinished_work: [],
						pending_approvals: [],
						important_artifacts: [],
					}),
				};
			}
			return {
				content: summaryResponse,
			};
		},
	} as unknown as BaseChatModel;
}

function createStubSession(
	threadId: string,
	messages: unknown[] = [],
	backend?: BackendProtocol,
): ChannelAgentSession {
	const backendInstance = backend ?? createBackend(`session-${threadId}`);
	return {
		threadId,
		agent: {
			async getState() {
				return { values: { messages } };
			},
		},
		workspace: backendInstance,
		model: createStubModel(),
		refreshAgent: async () => undefined,
	} as unknown as ChannelAgentSession;
}

// ---------------------------------------------------------------------------
// /new_thread without compaction context
// ---------------------------------------------------------------------------
describe("maybeHandleSessionCommand — /new_thread without compaction", () => {
	test("handles /new_thread and rotates thread", async () => {
		const session = createStubSession("thread-1", [
			{ role: "user", content: "hello" },
		]);
		const model = createStubModel("- archived hello");
		const backend = session.workspace;
		let minted = "";

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => {
				minted = "thread-2";
				return minted;
			},
		};

		const result = await maybeHandleSessionCommand("/new_thread", ctx);
		expect(result.handled).toBe(true);
		if (result.handled) {
			expect(result.reply).toContain("New thread started");
			expect(result.reply).toContain("thread-2");
			expect(result.reply).toContain("- archived hello");
		}
		expect(session.threadId).toBe("thread-2");
	});

	test("handles /new-thread alias", async () => {
		const session = createStubSession("thread-a", []);
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "thread-b",
		};

		const result = await maybeHandleSessionCommand("/new-thread", ctx);
		expect(result.handled).toBe(true);
	});

	test("does NOT create a forced checkpoint when compaction context is absent", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("thread-x", [
			{ role: "user", content: "some message" },
		]);
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "thread-y",
		};

		await maybeHandleSessionCommand("/new_thread", ctx);

		// No checkpoint should be created because compaction context was omitted
		const latest = await store.readLatest("caller-1", "thread-x");
		expect(latest).toBeNull();
		await close();
	});
});

// ---------------------------------------------------------------------------
// /new_thread with compaction context
// ---------------------------------------------------------------------------
describe("maybeHandleSessionCommand — /new_thread with compaction", () => {
	test("creates a forced checkpoint with new_thread boundary", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("thread-10", [
			{ role: "user", content: "Deploy the service" },
			{ role: "assistant", content: "Deploying now..." },
		]);
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "thread-11",
			compaction: {
				caller: "alice",
				store,
			},
		};

		await maybeHandleSessionCommand("/new_thread", ctx);

		const checkpoint = await store.readLatest("alice", "thread-10");
		expect(checkpoint).not.toBeNull();
		expect(checkpoint?.sourceBoundary).toBe("new_thread");
		expect(checkpoint?.caller).toBe("alice");
		expect(checkpoint?.threadId).toBe("thread-10");

		const parsed = JSON.parse(checkpoint?.summaryPayload ?? "{}");
		expect(typeof parsed.current_goal).toBe("string");
		await close();
	});

	test("checkpoint is for the old thread id, not the new one", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("old-thread", [
			{ role: "user", content: "hi" },
		]);
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "new-thread",
			compaction: { caller: "bob", store },
		};

		await maybeHandleSessionCommand("/new_thread", ctx);

		const oldCheckpoint = await store.readLatest("bob", "old-thread");
		expect(oldCheckpoint).not.toBeNull();
		expect(oldCheckpoint?.sourceBoundary).toBe("new_thread");

		// No checkpoint for the new thread id yet
		const newCheckpoint = await store.readLatest("bob", "new-thread");
		expect(newCheckpoint).toBeNull();
		await close();
	});

	test("thread is rotated even when compaction context is provided", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("t-before", []);
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "t-after",
			compaction: { caller: "carol", store },
		};

		const result = await maybeHandleSessionCommand("/new_thread", ctx);
		expect(result.handled).toBe(true);
		expect(session.threadId).toBe("t-after");
		await close();
	});
});

// ---------------------------------------------------------------------------
// Pending compaction seed after /new_thread
// ---------------------------------------------------------------------------
describe("maybeHandleSessionCommand — pending compaction seed", () => {
	test("sets pendingCompactionSeed on the session after /new_thread with compaction", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("thread-seed-test", [
			{ role: "user", content: "step 1" },
			{ role: "assistant", content: "done 1" },
			{ role: "user", content: "step 2" },
			{ role: "assistant", content: "done 2" },
		]);
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "new-seeded-thread",
			compaction: { caller: "seeder", store },
		};

		await maybeHandleSessionCommand("/new_thread", ctx);

		expect(session.pendingCompactionSeed).toBeDefined();
		expect(session.pendingCompactionSeed?.summary.current_goal).toBe(
			"test goal",
		);
		// last 2 turns from 4 messages = 4 messages
		expect(session.pendingCompactionSeed?.recentTurns).toHaveLength(4);
		await close();
	});

	test("seed summary contains the generated checkpoint content", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("thread-content-check", [
			{ role: "user", content: "build the feature" },
			{ role: "assistant", content: "building..." },
		]);
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "thread-after",
			compaction: { caller: "dev", store },
		};

		await maybeHandleSessionCommand("/new_thread", ctx);

		const seed = session.pendingCompactionSeed;
		expect(seed).toBeDefined();
		expect(typeof seed?.summary.current_goal).toBe("string");
		expect(Array.isArray(seed?.summary.decisions)).toBe(true);
		await close();
	});

	test("does NOT set pendingCompactionSeed when no compaction context", async () => {
		const session = createStubSession("thread-no-compact", [
			{ role: "user", content: "hi" },
		]);
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "new-no-compact",
		};

		await maybeHandleSessionCommand("/new_thread", ctx);
		expect(session.pendingCompactionSeed).toBeUndefined();
	});

	test("recentTurns in seed only includes last 2 turns from old thread", async () => {
		const { store, close } = createTempStore();
		// 3 full turns = 6 messages; last 2 turns = 4 messages
		const session = createStubSession("thread-long", [
			{ role: "user", content: "early" },
			{ role: "assistant", content: "early-reply" },
			{ role: "user", content: "middle" },
			{ role: "assistant", content: "middle-reply" },
			{ role: "user", content: "recent" },
			{ role: "assistant", content: "recent-reply" },
		]);
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "thread-next",
			compaction: { caller: "alice", store },
		};

		await maybeHandleSessionCommand("/new_thread", ctx);

		const recentTurns = session.pendingCompactionSeed?.recentTurns;
		if (!recentTurns) throw new Error("Expected pending compaction seed");
		expect(recentTurns).toHaveLength(4); // last 2 turns = 4 messages
		const contents = recentTurns.map((m) => m.content);
		expect(contents).not.toContain("early");
		expect(contents).toContain("middle");
		expect(contents).toContain("recent");
		await close();
	});

	test("thread is rotated AND seed is set in the same /new_thread call", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("thread-rotate-and-seed", [
			{ role: "user", content: "work item" },
			{ role: "assistant", content: "in progress" },
		]);
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "rotated-thread",
			compaction: { caller: "bob", store },
		};

		const result = await maybeHandleSessionCommand("/new_thread", ctx);

		expect(result.handled).toBe(true);
		expect(session.threadId).toBe("rotated-thread");
		expect(session.pendingCompactionSeed).toBeDefined();
		await close();
	});

	test("does not leave a pending seed behind when rotation fails after checkpoint creation", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("thread-rotation-failure", [
			{ role: "user", content: "work item" },
			{ role: "assistant", content: "still open" },
		]);
		const model = {
			async invoke(messages: Array<{ role: string; content: string }>) {
				const systemPrompt = messages[0]?.content ?? "";
				if (systemPrompt.includes("compacted into a checkpoint")) {
					return {
						content: JSON.stringify({
							current_goal: "test goal",
							decisions: [],
							constraints: [],
							unfinished_work: [],
							pending_approvals: [],
							important_artifacts: [],
						}),
					};
				}
				throw new Error("rotation summary failed");
			},
		} as unknown as BaseChatModel;
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "unused-thread",
			compaction: { caller: "dora", store },
		};

		await expect(maybeHandleSessionCommand("/new_thread", ctx)).rejects.toThrow(
			"rotation summary failed",
		);
		expect(session.threadId).toBe("thread-rotation-failure");
		expect(session.pendingCompactionSeed).toBeUndefined();

		const checkpoint = await store.readLatest("dora", "thread-rotation-failure");
		expect(checkpoint?.sourceBoundary).toBe("new_thread");
		await close();
	});
});

// ---------------------------------------------------------------------------
// Non-session commands pass through
// ---------------------------------------------------------------------------
describe("maybeHandleSessionCommand — passthrough", () => {
	test("returns handled: false for non-command input", async () => {
		const session = createStubSession("t-1");
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "t-2",
		};

		const result = await maybeHandleSessionCommand("hello world", ctx);
		expect(result.handled).toBe(false);
	});

	test("returns handled: false for unknown command", async () => {
		const session = createStubSession("t-1");
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "t-2",
		};

		const result = await maybeHandleSessionCommand("/unknown_cmd", ctx);
		expect(result.handled).toBe(false);
	});
});
