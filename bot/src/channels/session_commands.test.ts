import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import { SqliteStateBackend } from "../backends";
import { ForcedCheckpointStore } from "../checkpoints/forced_checkpoint_store";
import { createDb, detectDialect } from "../db";
import { PermissionsStore } from "../permissions/store";
import { TaskStore } from "../tasks/store";
import {
	maybeHandleSessionCommand,
	NEW_THREAD_RECENT_COMPLETED_WINDOW_MS,
	type SessionCommandContext,
} from "./session_commands";
import type { ChannelAgentSession } from "./shared";

const tempDirs: string[] = [];
const MEANINGFUL_CONTENT = "meaningful session command context ".repeat(900);

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

function createTaskStore(now?: () => number): {
	store: TaskStore;
	close: () => Promise<void>;
} {
	const db = new Bun.SQL("sqlite://:memory:");
	const store = new TaskStore({
		db,
		dialect: "sqlite",
		now,
	});
	return { store, close: () => db.close() };
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

	test("includes the summary, active tasks, and recent completed tasks in one reply", async () => {
		const fixedNow = 1_700_000_000_000;
		let taskNow = fixedNow - 10_000;
		const { store, close } = createTaskStore(() => taskNow++);
		try {
			const activeTask = await store.addTask({
				userId: "telegram:1",
				threadIdCreated: "thread-1",
				listName: "today",
				title: "Ship /new_thread reply",
				note: "Include task sections",
			});
			const recentTask = await store.addTask({
				userId: "telegram:1",
				threadIdCreated: "thread-1",
				listName: "today",
				title: "Write regression coverage",
			});
			await store.completeTask({
				taskId: recentTask.id,
				userId: "telegram:1",
				threadIdCompleted: "thread-1",
			});

			taskNow = fixedNow - NEW_THREAD_RECENT_COMPLETED_WINDOW_MS - 10_000;
			const staleTask = await store.addTask({
				userId: "telegram:1",
				threadIdCreated: "thread-older",
				listName: "backlog",
				title: "Ancient completion",
			});
			await store.completeTask({
				taskId: staleTask.id,
				userId: "telegram:1",
				threadIdCompleted: "thread-older",
			});

			taskNow = fixedNow - 5_000;
			const otherCallerTask = await store.addTask({
				userId: "telegram:2",
				threadIdCreated: "thread-other",
				listName: "today",
				title: "Other caller completion",
			});
			await store.completeTask({
				taskId: otherCallerTask.id,
				userId: "telegram:2",
				threadIdCompleted: "thread-other",
			});

			const session = createStubSession("thread-1", [
				{ role: "user", content: "hello" },
			]);
			session.taskCheckConfig = { caller: "telegram:1", store };
			const model = createStubModel("- archived hello");
			const backend = session.workspace;

			const ctx: SessionCommandContext = {
				session,
				model,
				backend,
				mintThreadId: () => "thread-2",
				now: () => fixedNow,
			};

			const result = await maybeHandleSessionCommand("/new_thread", ctx);
			expect(result.handled).toBe(true);
			if (!result.handled) {
				throw new Error("Expected /new_thread to be handled");
			}

			expect(result.reply).toContain("Previous thread summary");
			expect(result.reply).toContain("- archived hello");
			expect(result.reply).toContain("Current active tasks:");
			expect(result.reply).toContain("Ship /new_thread reply");
			expect(result.reply).toContain("Recently completed tasks");
			expect(result.reply).toContain("Write regression coverage");
			expect(result.reply).not.toContain("Ancient completion");
			expect(result.reply).not.toContain("Other caller completion");
			expect(result.reply).toContain("Include task sections");
			expect(session.threadId).toBe("thread-2");
			expect(activeTask.id).toBeGreaterThan(0);
		} finally {
			await close();
		}
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
			{ role: "user", content: `Deploy the service. ${MEANINGFUL_CONTENT}` },
			{ role: "assistant", content: `Deploying now. ${MEANINGFUL_CONTENT}` },
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
			{ role: "user", content: MEANINGFUL_CONTENT },
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
		expect(await store.readLatest("carol", "t-before")).toBeNull();
		await close();
	});

	test("does not create a checkpoint or seed for short trivial content", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("tiny-before", [
			{ role: "user", content: "hi" },
		]);
		const model = createStubModel();

		await maybeHandleSessionCommand("/new_thread", {
			session,
			model,
			backend: session.workspace,
			mintThreadId: () => "tiny-after",
			compaction: { caller: "tiny-user", store },
		});

		expect(session.threadId).toBe("tiny-after");
		expect(session.pendingCompactionSeed).toBeUndefined();
		expect(await store.readLatest("tiny-user", "tiny-before")).toBeNull();
		await close();
	});

	test("compacts the active checkpoint seed when rotating an already compacted thread", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("thread-with-seed", [
			{ role: "user", content: `new work ${MEANINGFUL_CONTENT}` },
			{ role: "assistant", content: `ack ${MEANINGFUL_CONTENT}` },
		]);
		session.pendingCompactionSeed = {
			summary: {
				current_goal: "Set a recurring reminder",
				decisions: [],
				constraints: [],
				unfinished_work: [],
				pending_approvals: [],
				important_artifacts: [],
			},
			recentTurns: [],
		};
		const seenCompactionInputs: string[] = [];
		const model = {
			async invoke(messages: Array<{ role: string; content: string }>) {
				const systemPrompt = messages[0]?.content ?? "";
				if (systemPrompt.includes("compacted into a checkpoint")) {
					seenCompactionInputs.push(messages[1]?.content ?? "");
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
				return { content: "- archived" };
			},
		} as unknown as BaseChatModel;

		await maybeHandleSessionCommand("/new_thread", {
			session,
			model,
			backend: session.workspace,
			mintThreadId: () => "thread-after-seed",
			compaction: { caller: "seeded-user", store },
		});

		expect(seenCompactionInputs[0]).toContain("Compacted Conversation Context");
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
			{ role: "user", content: `step 1 ${MEANINGFUL_CONTENT}` },
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
			{ role: "user", content: `build the feature ${MEANINGFUL_CONTENT}` },
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

	test("sets pendingTaskCheck for the next substantive turn after /new_thread when compaction is configured", async () => {
		const { store, close } = createTempStore();
		const session = createStubSession("thread-task-check", [
			{ role: "user", content: "hi" },
		]);
		session.pendingTaskCheck = false;
		const model = createStubModel();
		const backend = session.workspace;

		const ctx: SessionCommandContext = {
			session,
			model,
			backend,
			mintThreadId: () => "thread-task-check-next",
			compaction: { caller: "alice", store },
		};

		await maybeHandleSessionCommand("/new_thread", ctx);
		expect(session.pendingTaskCheck).toBe(true);
		await close();
	});

	test("recentTurns in seed only includes last 2 turns from old thread", async () => {
		const { store, close } = createTempStore();
		// 3 full turns = 6 messages; last 2 turns = 4 messages
		const session = createStubSession("thread-long", [
			{ role: "user", content: `early ${MEANINGFUL_CONTENT}` },
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
			{ role: "user", content: `work item ${MEANINGFUL_CONTENT}` },
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
			{ role: "user", content: `work item ${MEANINGFUL_CONTENT}` },
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

		const checkpoint = await store.readLatest(
			"dora",
			"thread-rotation-failure",
		);
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

// ---------------------------------------------------------------------------
// /identity commands
// ---------------------------------------------------------------------------

function createIdentityStore(): {
	store: PermissionsStore;
	close: () => Promise<void>;
} {
	const db = new Bun.SQL("sqlite://:memory:");
	const store = new PermissionsStore({ db, dialect: "sqlite" });
	return { store, close: () => db.close() };
}

async function createIdentityCtx(
	session: ChannelAgentSession,
	storeSetup?: (store: PermissionsStore) => Promise<void>,
): Promise<{ ctx: SessionCommandContext; close: () => Promise<void> }> {
	const { store, close } = createIdentityStore();
	await store.upsertUser({ entrypoint: "telegram", externalId: "1" });
	if (storeSetup) await storeSetup(store);
	const ctx: SessionCommandContext = {
		session,
		model: createStubModel(),
		backend: session.workspace,
		mintThreadId: () => `thread-${Date.now()}`,
		identity: { store, callerId: "telegram:1" },
	};
	return { ctx, close };
}

describe("maybeHandleSessionCommand — /identity", () => {
	test("/identity without identity context replies with not-configured message", async () => {
		const session = createStubSession("t-ident-0");
		const ctx: SessionCommandContext = {
			session,
			model: createStubModel(),
			backend: session.workspace,
			mintThreadId: () => "t-ident-0b",
		};
		const result = await maybeHandleSessionCommand("/identity", ctx);
		expect(result.handled).toBe(true);
		if (result.handled) expect(result.reply).toContain("not configured");
	});

	test("/identity lists all presets with commands and marks current", async () => {
		const session = createStubSession("t-ident-1");
		const { ctx, close } = await createIdentityCtx(session);
		try {
			const result = await maybeHandleSessionCommand("/identity", ctx);
			expect(result.handled).toBe(true);
			if (result.handled) {
				// Shows current
				expect(result.reply).toContain("Current:");
				// Lists all three presets
				expect(result.reply).toContain("do_it_doggo");
				expect(result.reply).toContain("business_doggo");
				expect(result.reply).toContain("good_kiddo");
				// Each has a copy-paste command
				expect(result.reply).toContain("/identity do_it_doggo");
				expect(result.reply).toContain("/identity business_doggo");
				expect(result.reply).toContain("/identity good_kiddo");
			}
		} finally {
			await close();
		}
	});

	test("/identity marks the active preset with a checkmark", async () => {
		const session = createStubSession("t-ident-2");
		session.selectedIdentityId = "do_it_doggo";
		const { ctx, close } = await createIdentityCtx(session);
		try {
			const result = await maybeHandleSessionCommand("/identity", ctx);
			expect(result.handled).toBe(true);
			if (result.handled) {
				expect(result.reply).toContain("✓");
				expect(result.reply).toContain("do_it_doggo");
			}
		} finally {
			await close();
		}
	});

	test("/identity <preset> switches to known preset and rotates thread", async () => {
		const session = createStubSession("t-ident-3", [
			{ role: "user", content: "hello" },
		]);
		const originalThread = session.threadId;
		const { ctx, close } = await createIdentityCtx(session);
		try {
			const result = await maybeHandleSessionCommand(
				"/identity do_it_doggo",
				ctx,
			);
			expect(result.handled).toBe(true);
			if (result.handled) {
				expect(result.reply).toContain("Do-It Doggo");
				expect(result.reply).toContain("fresh context");
			}
			expect(session.selectedIdentityId).toBe("do_it_doggo");
			expect(session.threadId).not.toBe(originalThread);
			const user = await ctx.identity?.store.getUserById("telegram:1");
			expect(user?.identityId).toBe("do_it_doggo");
		} finally {
			await close();
		}
	});

	test("/identity <preset> is a no-op when preset is already active", async () => {
		const session = createStubSession("t-ident-4");
		session.selectedIdentityId = "do_it_doggo";
		const { ctx, close } = await createIdentityCtx(session);
		try {
			const result = await maybeHandleSessionCommand(
				"/identity do_it_doggo",
				ctx,
			);
			expect(result.handled).toBe(true);
			if (result.handled) expect(result.reply).toContain("Already using");
			expect(session.threadId).toBe("t-ident-4");
		} finally {
			await close();
		}
	});

	test("/identity <unknown> returns error and lists identities with commands", async () => {
		const session = createStubSession("t-ident-5");
		const { ctx, close } = await createIdentityCtx(session);
		try {
			const result = await maybeHandleSessionCommand("/identity nope", ctx);
			expect(result.handled).toBe(true);
			if (result.handled) {
				expect(result.reply).toContain("Unknown identity");
				// Falls through to the list so user can pick a valid one
				expect(result.reply).toContain("/identity good_kiddo");
				expect(result.reply).toContain("/identity do_it_doggo");
			}
			expect(session.selectedIdentityId).toBeUndefined();
		} finally {
			await close();
		}
	});

	test("/identity good_kiddo switches from a non-default preset back to default", async () => {
		const session = createStubSession("t-ident-6", [
			{ role: "user", content: "hello" },
		]);
		session.selectedIdentityId = "do_it_doggo";
		const originalThread = session.threadId;
		const { ctx, close } = await createIdentityCtx(session, async (store) => {
			await store.setUserIdentity("telegram:1", "do_it_doggo");
		});
		try {
			const result = await maybeHandleSessionCommand(
				"/identity good_kiddo",
				ctx,
			);
			expect(result.handled).toBe(true);
			if (result.handled) expect(result.reply).toContain("Good Kiddo");
			expect(session.selectedIdentityId).toBe("good_kiddo");
			expect(session.threadId).not.toBe(originalThread);
		} finally {
			await close();
		}
	});
});
