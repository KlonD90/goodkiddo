import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import { ForcedCheckpointStore } from "../checkpoints/forced_checkpoint_store";
import type { AppConfig } from "../config";
import { createDb } from "../db/index";
import type { CheckpointSummary } from "../memory/checkpoint_compaction";
import type { ThreadMessage } from "../memory/summarize";
import type { ApprovalBroker } from "../permissions/approval";
import { PermissionsStore } from "../permissions/store";
import { TaskStore } from "../tasks/store";
import type { ChannelAgentSession } from "./shared";
import {
	buildInvokeMessages,
	clearPendingCompactionSeed,
	clearPendingTaskCheckContext,
	createChannelAgentSession,
	extractAgentReply,
	extractTextFromContent,
	maybeAutoCompactAndSeed,
	maybeResumeCompactAndSeed,
	maybeRunPendingTaskCheck,
	recoverPendingSeedForEmptyThread,
	refreshAgentIfPromptDirty,
	seedFromCheckpoint,
} from "./shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const MEANINGFUL_CONTENT = "meaningful shared compaction context ".repeat(900);

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

const TEST_CONFIG: AppConfig = {
	aiApiKey: "test-key",
	aiBaseUrl: "",
	aiType: "openai",
	aiModelName: "gpt-4o-mini",
	appEntrypoint: "cli",
	telegramBotToken: "",
	telegramAllowedChatId: "",
	usingMode: "single",
	blockedUserMessage: "blocked",
	maxContextWindowTokens: 150000,
	contextReserveSummaryTokens: 2000,
	contextReserveRecentTurnTokens: 2000,
	contextReserveNextTurnTokens: 2000,
	permissionsMode: "disabled",
	databaseUrl: "sqlite://:memory:",
	enableExecute: false,
	enablePdfDocuments: true,
	enableSpreadsheets: true,
	enableImageUnderstanding: false,
	enableToolStatus: true,
	enableAttachmentCompactionNotice: true,
	defaultStatusLocale: "en",
	enableVoiceMessages: true,
	transcriptionProvider: "openai",
	transcriptionApiKey: "test-key",
	transcriptionBaseUrl: "",
	minimaxApiKey: "",
	minimaxApiHost: "https://api.minimax.io",
	webHost: "127.0.0.1",
	webPort: 8083,
	webPublicBaseUrl: "http://localhost:8083",
	timezone: "UTC",
};

const NOOP_BROKER: ApprovalBroker = {
	requestApproval: async () => "deny-once",
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

describe("channel task-check state", () => {
	test("createChannelAgentSession enables pendingTaskCheck for a new session", async () => {
		const db = createDb("sqlite://:memory:");
		try {
			const store = new PermissionsStore({ db, dialect: "sqlite" });
			const session = await createChannelAgentSession(TEST_CONFIG, {
				db,
				dialect: "sqlite",
				caller: {
					id: "cli:tester",
					entrypoint: "cli",
					externalId: "tester",
					displayName: "Tester",
				},
				store,
				broker: NOOP_BROKER,
				threadId: "cli-tester",
			});

			expect(session.pendingTaskCheck).toBe(true);
			expect(session.taskCheckConfig?.caller).toBe("cli:tester");
		} finally {
			await db.close();
		}
	});

	test("runs reconciliation on the first substantive turn of a new session", async () => {
		const db = createDb("sqlite://:memory:");
		try {
			const store = new PermissionsStore({ db, dialect: "sqlite" });
			const session = await createChannelAgentSession(TEST_CONFIG, {
				db,
				dialect: "sqlite",
				caller: {
					id: "cli:tester",
					entrypoint: "cli",
					externalId: "tester",
					displayName: "Tester",
				},
				store,
				broker: NOOP_BROKER,
				threadId: "cli-tester",
			});
			const taskStore = session.taskCheckConfig?.store;
			if (!taskStore) throw new Error("Expected task-check store");
			await taskStore.addTask({
				userId: "cli:tester",
				threadIdCreated: session.threadId,
				listName: "today",
				title: "Review task boundary tests",
			});

			const result = await maybeRunPendingTaskCheck(
				session,
				"I finished review task boundary tests.",
			);

			expect(result).toEqual({
				handled: false,
				needsRefresh: true,
			});
			expect(session.pendingTaskCheck).toBe(false);
			expect(session.pendingTaskCheckContext).toContain(
				"Automatically completed active task",
			);
			expect(await taskStore.listActiveTasks("cli:tester")).toHaveLength(0);
		} finally {
			await db.close();
		}
	});

	test("maybeRunPendingTaskCheck consumes the boundary flag and adds one-turn context for obvious completions", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		try {
			const store = new TaskStore({ db, dialect: "sqlite" });
			await store.addTask({
				userId: "cli:tester",
				threadIdCreated: "thread-a",
				listName: "today",
				title: "Ship release notes",
			});
			const session = stubSession({
				threadId: "thread-b",
				pendingTaskCheck: true,
				taskCheckConfig: {
					caller: "cli:tester",
					store,
				},
			});

			const result = await maybeRunPendingTaskCheck(
				session,
				"I finished ship release notes.",
			);

			expect(result).toEqual({
				handled: false,
				needsRefresh: true,
			});
			expect(session.pendingTaskCheck).toBe(false);
			expect(session.pendingTaskCheckContext).toContain(
				"Automatically completed active task",
			);
			expect(await store.listActiveTasks("cli:tester")).toHaveLength(0);

			clearPendingTaskCheckContext(session);
			expect(session.pendingTaskCheckContext).toBeUndefined();
		} finally {
			await db.close();
		}
	});

	test("leaves ambiguous completion candidates unchanged on boundary turns", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		try {
			const store = new TaskStore({ db, dialect: "sqlite" });
			await store.addTask({
				userId: "cli:tester",
				threadIdCreated: "thread-a",
				listName: "today",
				title: "Fix webhook bug",
			});
			await store.addTask({
				userId: "cli:tester",
				threadIdCreated: "thread-a",
				listName: "today",
				title: "Fix checkout bug",
			});
			const session = stubSession({
				threadId: "thread-b",
				pendingTaskCheck: true,
				taskCheckConfig: {
					caller: "cli:tester",
					store,
				},
			});

			const result = await maybeRunPendingTaskCheck(
				session,
				"I fixed the bug.",
			);

			expect(result).toEqual({
				handled: false,
				needsRefresh: false,
			});
			expect(session.pendingTaskCheck).toBe(false);
			expect(session.pendingTaskCheckContext).toBeUndefined();
			expect(await store.listActiveTasks("cli:tester")).toHaveLength(2);
		} finally {
			await db.close();
		}
	});

	test("returns a confirmation prompt for dismiss candidates on boundary turns", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		try {
			const store = new TaskStore({ db, dialect: "sqlite" });
			const task = await store.addTask({
				userId: "cli:tester",
				threadIdCreated: "thread-a",
				listName: "backlog",
				title: "Draft migration plan",
			});
			const session = stubSession({
				threadId: "thread-b",
				pendingTaskCheck: true,
				taskCheckConfig: {
					caller: "cli:tester",
					store,
				},
			});

			const result = await maybeRunPendingTaskCheck(
				session,
				"We don't need draft migration plan anymore.",
			);

			expect(result).toEqual({
				handled: true,
				reply: expect.stringContaining(`dismiss task ${task.id}`),
				needsRefresh: false,
			});
			expect(session.pendingTaskCheck).toBe(false);
			expect(session.pendingTaskCheckContext).toBeUndefined();
			expect(await store.getTask(task.id, "cli:tester")).toMatchObject({
				id: task.id,
				status: "active",
			});
		} finally {
			await db.close();
		}
	});

	test("keeps the boundary flag for whitespace-only turns", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		try {
			const store = new TaskStore({ db, dialect: "sqlite" });
			const session = stubSession({
				threadId: "thread-b",
				pendingTaskCheck: true,
				taskCheckConfig: {
					caller: "cli:tester",
					store,
				},
			});

			const result = await maybeRunPendingTaskCheck(session, "   \n\t  ");

			expect(result).toEqual({
				handled: false,
				needsRefresh: false,
			});
			expect(session.pendingTaskCheck).toBe(true);
			expect(session.pendingTaskCheckContext).toBeUndefined();
		} finally {
			await db.close();
		}
	});

	test("keeps the boundary flag for image-only turns", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		try {
			const store = new TaskStore({ db, dialect: "sqlite" });
			const session = stubSession({
				threadId: "thread-b",
				pendingTaskCheck: true,
				taskCheckConfig: {
					caller: "cli:tester",
					store,
				},
			});

			const result = await maybeRunPendingTaskCheck(session, [
				{ type: "image", mimeType: "image/png", data: new Uint8Array([1]) },
			]);

			expect(result).toEqual({
				handled: false,
				needsRefresh: false,
			});
			expect(session.pendingTaskCheck).toBe(true);
			expect(session.pendingTaskCheckContext).toBeUndefined();
		} finally {
			await db.close();
		}
	});

	test("preserves the boundary flag when reconciliation throws", async () => {
		const session = stubSession({
			threadId: "thread-b",
			pendingTaskCheck: true,
			pendingTaskCheckContext: "keep-existing-context",
			taskCheckConfig: {
				caller: "cli:tester",
				store: {
					async listActiveTasks() {
						throw new Error("task store unavailable");
					},
				} as unknown as TaskStore,
			},
		});

		await expect(
			maybeRunPendingTaskCheck(session, "I finished the work."),
		).rejects.toThrow("task store unavailable");
		expect(session.pendingTaskCheck).toBe(true);
		expect(session.pendingTaskCheckContext).toBe("keep-existing-context");
	});

	test("does not run reconciliation on non-boundary turns", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		try {
			const store = new TaskStore({ db, dialect: "sqlite" });
			const task = await store.addTask({
				userId: "cli:tester",
				threadIdCreated: "thread-a",
				listName: "today",
				title: "Ship release notes",
			});
			const session = stubSession({
				threadId: "thread-b",
				pendingTaskCheck: false,
				taskCheckConfig: {
					caller: "cli:tester",
					store,
				},
			});

			const result = await maybeRunPendingTaskCheck(
				session,
				"I finished ship release notes.",
			);

			expect(result).toEqual({
				handled: false,
				needsRefresh: false,
			});
			expect(await store.getTask(task.id, "cli:tester")).toMatchObject({
				id: task.id,
				status: "active",
			});
		} finally {
			await db.close();
		}
	});
});

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

describe("buildInvokeMessages — current turn time", () => {
	test("prepends current Telegram message time as user metadata", () => {
		const session = stubSession({
			currentTurnContext: {
				now: new Date("2026-04-24T12:30:00.000Z"),
				source: "telegram_message",
				requiresExplicitTimerTimezone: true,
			},
		});
		const messages = buildInvokeMessages(session, {
			role: "user",
			content: "remind me in 30 minutes",
		});

		expect(messages).toHaveLength(2);
		expect(messages[0]?.role).toBe("user");
		expect(messages[0]?.content).toContain(
			"Current message time in UTC: 2026-04-24T12:30:00.000Z",
		);
		expect(messages[0]?.content).toContain("Telegram message timestamp");
		expect(messages[0]?.content).toContain(
			'duration-only one-time reminders like "in 5 minutes"',
		);
		expect(messages[0]?.content).toContain("runAtUtc");
		expect(messages[0]?.content).toContain("recurring timer needs a timezone");
		expect(messages[0]?.content).toContain("memory_write");
		expect(messages[1]).toMatchObject({
			role: "user",
			content: "remind me in 30 minutes",
		});
	});
});

describe("buildInvokeMessages — with pending seed", () => {
	test("does not inject checkpoint context into persisted turn messages", () => {
		const recentTurns = makeMessages(["prev-q", "prev-a"]);
		const session = stubSession({
			pendingCompactionSeed: { summary: SAMPLE_SUMMARY, recentTurns },
		});

		const result = buildInvokeMessages(session, {
			role: "user",
			content: "next question",
		});

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ role: "user", content: "next question" });
	});

	test("keeps pendingCompactionSeed until the caller explicitly clears it", () => {
		const session = stubSession({
			pendingCompactionSeed: {
				summary: SAMPLE_SUMMARY,
				recentTurns: [],
			},
		});

		buildInvokeMessages(session, { role: "user", content: "first" });
		expect(session.pendingCompactionSeed).toBeDefined();
	});

	test("subsequent call after clear returns only current user message", () => {
		const session = stubSession({
			pendingCompactionSeed: { summary: SAMPLE_SUMMARY, recentTurns: [] },
		});

		buildInvokeMessages(session, { role: "user", content: "first" });
		clearPendingCompactionSeed(session);
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

	test("empty recentTurns still returns only the current user turn", () => {
		const session = stubSession({
			pendingCompactionSeed: { summary: SAMPLE_SUMMARY, recentTurns: [] },
		});

		const result = buildInvokeMessages(session, {
			role: "user",
			content: "go",
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ role: "user", content: "go" });
	});
});

describe("refreshAgentIfPromptDirty", () => {
	test("refreshes the agent once when prompt-injected memory changed", async () => {
		let refreshes = 0;
		const session = stubSession({
			promptNeedsRefresh: true,
			refreshAgent: async () => {
				refreshes++;
			},
		});

		await refreshAgentIfPromptDirty(session);
		await refreshAgentIfPromptDirty(session);

		expect(refreshes).toBe(1);
		expect(session.promptNeedsRefresh).toBe(false);
	});

	test("does nothing when the prompt is clean", async () => {
		let refreshes = 0;
		const session = stubSession({
			promptNeedsRefresh: false,
			refreshAgent: async () => {
				refreshes++;
			},
		});

		await refreshAgentIfPromptDirty(session);

		expect(refreshes).toBe(0);
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

describe("recoverPendingSeedForEmptyThread", () => {
	test("recovers the latest checkpoint for callers whose rotated thread is still empty", async () => {
		const { store, close } = createTempStore();
		await store.create({
			caller: "recover-user",
			threadId: "old-thread",
			sourceBoundary: "new_thread",
			summaryPayload: JSON.stringify(SAMPLE_SUMMARY),
		});

		const session = stubSession({
			threadId: "new-empty-thread",
			agent: {
				async getState(config: { configurable: { thread_id: string } }) {
					if (config.configurable.thread_id === "old-thread") {
						return {
							values: {
								messages: makeMessages(
									["older", "older-reply"],
									["recent", "recent-reply"],
								),
							},
						};
					}
					return { values: { messages: [] } };
				},
			} as unknown as ChannelAgentSession["agent"],
		});

		const recovered = await recoverPendingSeedForEmptyThread(
			session,
			"recover-user",
			store,
		);

		expect(recovered).toBe(true);
		expect(session.pendingCompactionSeed?.summary.current_goal).toBe(
			"Deploy the service",
		);
		expect(
			session.pendingCompactionSeed?.recentTurns.map(({ role, content }) => ({
				role,
				content,
			})),
		).toEqual(
			makeMessages(["older", "older-reply"], ["recent", "recent-reply"]),
		);
		await close();
	});

	test("does not recover when the latest checkpoint already belongs to the active thread", async () => {
		const { store, close } = createTempStore();
		await store.create({
			caller: "recover-user",
			threadId: "same-thread",
			sourceBoundary: "message_limit",
			summaryPayload: JSON.stringify(SAMPLE_SUMMARY),
		});
		const session = stubSession({ threadId: "same-thread" });

		const recovered = await recoverPendingSeedForEmptyThread(
			session,
			"recover-user",
			store,
		);

		expect(recovered).toBe(false);
		expect(session.pendingCompactionSeed).toBeUndefined();
		await close();
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
	test("returns false when thresholds are exceeded but prior content is trivial", async () => {
		const { store, close } = createTempStore();
		const session = stubSession({
			model: {
				async invoke() {
					throw new Error("should not compact trivial content");
				},
			} as unknown as BaseChatModel,
			compactionConfig: {
				caller: "tiny-user",
				store,
				thresholds: { messageLimit: 1, tokenBudget: 1 },
			},
		});

		const result = await maybeAutoCompactAndSeed(
			session,
			makeMessages(["x", "y"]),
			"next",
			() => "unused",
		);

		expect(result).toBe(false);
		expect(session.threadId).toBe("test-thread");
		expect(session.pendingCompactionSeed).toBeUndefined();
		expect(await store.readLatest("tiny-user", "test-thread")).toBeNull();
		await close();
	});

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
		const messages = makeMessages([
			`q1 ${MEANINGFUL_CONTENT}`,
			`a1 ${MEANINGFUL_CONTENT}`,
		]); // exactly 2 messages → hits messageLimit:2

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
		const messages = makeMessages([
			`q1 ${MEANINGFUL_CONTENT}`,
			`a1 ${MEANINGFUL_CONTENT}`,
		]); // triggers at 2

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

		expect(invokeMessages).toHaveLength(1);
		expect(invokeMessages[0]).toMatchObject({
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
		const messages = makeMessages([
			`q1 ${MEANINGFUL_CONTENT}`,
			`a1 ${MEANINGFUL_CONTENT}`,
		]);

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

	test("token-budget compaction counts multimodal pending input conservatively", async () => {
		const { store, close } = createTempStore();
		const session = stubSession({
			model: {
				async invoke() {
					return { content: JSON.stringify(SAMPLE_SUMMARY) };
				},
			} as unknown as BaseChatModel,
			compactionConfig: {
				caller: "user-6",
				store,
				thresholds: { messageLimit: 100, tokenBudget: 1000 },
			},
		});

		const result = await maybeAutoCompactAndSeed(
			session,
			[{ role: "user", content: MEANINGFUL_CONTENT }],
			[
				{ type: "text", text: "please inspect this" },
				{ type: "image", mimeType: "image/png", data: new Uint8Array([1, 2]) },
			],
			() => "new-thread-multimodal",
		);

		expect(result).toBe(true);
		const checkpoint = await store.readLatest("user-6", "test-thread");
		expect(checkpoint?.sourceBoundary).toBe("token_limit");
		await close();
	});

	test("summarizes the active checkpoint seed when compacting an already compacted thread", async () => {
		const { store, close } = createTempStore();
		const seen: Array<{ role: string; content: string }> = [];
		const model = {
			async invoke(messages: Array<{ role: string; content: string }>) {
				seen.push(...messages);
				return {
					content: JSON.stringify({
						...SAMPLE_SUMMARY,
						current_goal: "Continue from compacted context",
					}),
				};
			},
		} as unknown as BaseChatModel;

		const session = stubSession({
			model,
			pendingCompactionSeed: {
				summary: SAMPLE_SUMMARY,
				recentTurns: [],
			},
			compactionConfig: {
				caller: "user-with-seed",
				store,
				thresholds: { messageLimit: 1, tokenBudget: 1_000_000 },
			},
		});

		const result = await maybeAutoCompactAndSeed(
			session,
			makeMessages([
				`new work ${MEANINGFUL_CONTENT}`,
				`ack ${MEANINGFUL_CONTENT}`,
			]),
			"continue",
			() => "new-thread-with-seed",
		);

		expect(result).toBe(true);
		expect(seen[1]?.content).toContain("Compacted Conversation Context");
		expect(session.pendingCompactionSeed?.summary.current_goal).toBe(
			"Continue from compacted context",
		);
		await close();
	});

	test("preserves the original thread when persisting the rotated thread id fails", async () => {
		const { store, close } = createTempStore();
		const session = stubSession({
			model: {
				async invoke() {
					return { content: JSON.stringify(SAMPLE_SUMMARY) };
				},
			} as unknown as BaseChatModel,
			persistThreadId: async () => {
				throw new Error("persist failed");
			},
			compactionConfig: {
				caller: "user-5",
				store,
				thresholds: { messageLimit: 2, tokenBudget: 1_000_000 },
			},
		});

		await expect(
			maybeAutoCompactAndSeed(
				session,
				makeMessages([`q1 ${MEANINGFUL_CONTENT}`, `a1 ${MEANINGFUL_CONTENT}`]),
				"next",
				() => "rotated-thread",
			),
		).rejects.toThrow(
			"Failed to persist thread ID change from test-thread to rotated-thread",
		);
		expect(session.threadId).toBe("test-thread");
		expect(session.pendingCompactionSeed).toBeUndefined();
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
		const messages = makeMessages(
			[`q1 ${MEANINGFUL_CONTENT}`, `a1 ${MEANINGFUL_CONTENT}`],
			["q2", "a2"],
		);
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

	test("clears resume-compaction state for trivial stored history", async () => {
		const { store, close } = createTempStore();
		const session = stubSession({
			needsResumeCompaction: true,
			compactionConfig: {
				caller: "resume-tiny-user",
				store,
			},
		});

		const result = await maybeResumeCompactAndSeed(
			session,
			makeMessages(["hi", "ok"]),
			() => "unused",
		);

		expect(result).toBe(false);
		expect(session.threadId).toBe("test-thread");
		expect(session.pendingCompactionSeed).toBeUndefined();
		expect(session.needsResumeCompaction).toBe(false);
		expect(
			await store.readLatest("resume-tiny-user", "test-thread"),
		).toBeNull();
		await close();
	});

	test("preserves resume-compaction state when checkpoint creation fails", async () => {
		const { store, close } = createTempStore();
		const session = stubSession({
			model: {
				async invoke() {
					throw new Error("LLM unavailable");
				},
			} as unknown as BaseChatModel,
			needsResumeCompaction: true,
			compactionConfig: {
				caller: "resume-user",
				store,
			},
		});

		await expect(
			maybeResumeCompactAndSeed(
				session,
				makeMessages([`q1 ${MEANINGFUL_CONTENT}`, `a1 ${MEANINGFUL_CONTENT}`]),
				() => "unused",
			),
		).rejects.toThrow("LLM unavailable");
		expect(session.threadId).toBe("test-thread");
		expect(session.pendingCompactionSeed).toBeUndefined();
		expect(session.needsResumeCompaction).toBe(true);
		await close();
	});

	test("preserves resume-compaction state when persisting the rotated thread id fails", async () => {
		const { store, close } = createTempStore();
		const session = stubSession({
			model: {
				async invoke() {
					return { content: JSON.stringify(SAMPLE_SUMMARY) };
				},
			} as unknown as BaseChatModel,
			needsResumeCompaction: true,
			persistThreadId: async () => {
				throw new Error("persist failed");
			},
			compactionConfig: {
				caller: "resume-user",
				store,
			},
		});

		await expect(
			maybeResumeCompactAndSeed(
				session,
				makeMessages([`q1 ${MEANINGFUL_CONTENT}`, `a1 ${MEANINGFUL_CONTENT}`]),
				() => "rotated-thread",
			),
		).rejects.toThrow(
			"Failed to persist thread ID change from test-thread to rotated-thread",
		);
		expect(session.threadId).toBe("test-thread");
		expect(session.pendingCompactionSeed).toBeUndefined();
		expect(session.needsResumeCompaction).toBe(true);
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
