import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reconcileActiveTasksAtBoundary } from "./reconcile";
import { TaskStore } from "./store";

let db: InstanceType<typeof Bun.SQL>;
let store: TaskStore;
let now: number;

beforeEach(() => {
	now = 1_000;
	db = new Bun.SQL("sqlite://:memory:");
	store = new TaskStore({
		db,
		dialect: "sqlite",
		now: () => now++,
	});
});

afterEach(async () => {
	await db.close();
});

describe("reconcileActiveTasksAtBoundary", () => {
	test("auto-completes an exact single active-task match", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Ship webhook handler",
		});
		await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "backlog",
			title: "Plan docs follow-up",
		});

		const result = await reconcileActiveTasksAtBoundary({
			store,
			userId: "telegram:1",
			threadId: "thread-b",
			messageText: "I finished ship webhook handler.",
		});

		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") {
			throw new Error("Expected auto-complete result");
		}
		expect(result.task.id).toBe(task.id);
		expect(result.task.status).toBe("completed");
		expect(result.task.threadIdCompleted).toBe("thread-b");
		expect(result.agentContext).toContain(
			"Automatically completed active task",
		);

		const activeTasks = await store.listActiveTasks("telegram:1");
		expect(activeTasks).toHaveLength(1);
		expect(activeTasks[0]?.title).toBe("Plan docs follow-up");
	});

	test("leaves ambiguous completion candidates unchanged", async () => {
		await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Fix webhook bug",
		});
		await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Fix checkout bug",
		});

		const result = await reconcileActiveTasksAtBoundary({
			store,
			userId: "telegram:1",
			threadId: "thread-b",
			messageText: "I fixed the bug.",
		});

		expect(result).toEqual({ kind: "none" });
		const activeTasks = await store.listActiveTasks("telegram:1");
		expect(activeTasks).toHaveLength(2);
	});

	test("does not auto-complete low-confidence generic completion messages", async () => {
		await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Prepare rollout checklist",
		});

		const result = await reconcileActiveTasksAtBoundary({
			store,
			userId: "telegram:1",
			threadId: "thread-b",
			messageText: "Done.",
		});

		expect(result).toEqual({ kind: "none" });
		expect(await store.listActiveTasks("telegram:1")).toHaveLength(1);
	});

	test("auto-completes an explicitly referenced task id", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Ship webhook handler",
		});

		const result = await reconcileActiveTasksAtBoundary({
			store,
			userId: "telegram:1",
			threadId: "thread-b",
			messageText: `Yes, task ${task.id} is done.`,
		});

		expect(result.kind).toBe("completed");
		expect(await store.listActiveTasks("telegram:1")).toHaveLength(0);
	});

	test("preserves task metadata when auto-completing at a boundary", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "follow-up",
			title: "Send client recap",
			note: "after kickoff",
			dueAt: 2_000,
			nextCheckAt: 1_500,
			priority: 2,
			loopType: "client_followup",
			sourceContext: "kickoff transcript",
			sourceRef: "msg:123",
			lastNudgedAt: 1_250,
			nudgeCount: 1,
			snoozedUntil: 1_400,
		});

		const result = await reconcileActiveTasksAtBoundary({
			store,
			userId: "telegram:1",
			threadId: "thread-b",
			messageText: "I finished send client recap.",
		});

		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") {
			throw new Error("Expected auto-complete result");
		}
		expect(result.task).toMatchObject({
			id: task.id,
			status: "completed",
			dueAt: 2_000,
			nextCheckAt: 1_500,
			priority: 2,
			loopType: "client_followup",
			sourceContext: "kickoff transcript",
			sourceRef: "msg:123",
			lastNudgedAt: 1_250,
			nudgeCount: 1,
			snoozedUntil: 1_400,
		});
		expect(await store.getTask(task.id, "telegram:1")).toMatchObject({
			status: "completed",
			dueAt: 2_000,
			nextCheckAt: 1_500,
			priority: 2,
			loopType: "client_followup",
			sourceContext: "kickoff transcript",
			sourceRef: "msg:123",
			lastNudgedAt: 1_250,
			nudgeCount: 1,
			snoozedUntil: 1_400,
		});
	});

	test("auto-completes a note-based phrase match", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Finalize release",
			note: "verify rollback checklist",
		});

		const result = await reconcileActiveTasksAtBoundary({
			store,
			userId: "telegram:1",
			threadId: "thread-b",
			messageText: "I completed verify rollback checklist.",
		});

		expect(result.kind).toBe("completed");
		if (result.kind !== "completed") {
			throw new Error("Expected auto-complete result");
		}
		expect(result.task.id).toBe(task.id);
	});

	test("does not auto-complete negated completion phrases", async () => {
		await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Ship webhook handler",
		});

		const result = await reconcileActiveTasksAtBoundary({
			store,
			userId: "telegram:1",
			threadId: "thread-b",
			messageText: "The webhook handler is not done yet.",
		});

		expect(result).toEqual({ kind: "none" });
		expect(await store.listActiveTasks("telegram:1")).toHaveLength(1);
	});

	test("does not auto-complete loose token overlaps from unrelated completion text", async () => {
		await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Auth middleware",
		});

		const result = await reconcileActiveTasksAtBoundary({
			store,
			userId: "telegram:1",
			threadId: "thread-b",
			messageText: "I finished the auth docs, but middleware is next.",
		});

		expect(result).toEqual({ kind: "none" });
		expect(await store.listActiveTasks("telegram:1")).toHaveLength(1);
	});

	test("turns dismiss candidates into confirmation prompts without mutating state", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "backlog",
			title: "Draft migration plan",
		});

		const result = await reconcileActiveTasksAtBoundary({
			store,
			userId: "telegram:1",
			threadId: "thread-b",
			messageText: "We don't need draft migration plan anymore.",
		});

		expect(result.kind).toBe("dismiss_confirmation");
		if (result.kind !== "dismiss_confirmation") {
			throw new Error("Expected dismiss confirmation result");
		}
		expect(result.tasks.map((candidate) => candidate.id)).toEqual([task.id]);
		expect(result.reply).toContain(`dismiss task ${task.id}`);
		expect(await store.getTask(task.id, "telegram:1")).toMatchObject({
			id: task.id,
			status: "active",
		});
	});
});
