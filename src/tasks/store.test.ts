import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatActiveTaskSnapshot, TaskStore } from "./store";

type IndexListRow = {
	seq: number;
	name: string;
	unique: 0 | 1;
	origin: string;
	partial: 0 | 1;
};

type IndexInfoRow = {
	seqno: number;
	cid: number;
	name: string;
};

type TableInfoRow = {
	cid: number;
	name: string;
	type: string;
	notnull: 0 | 1;
	dflt_value: string | null;
	pk: 0 | 1;
};

let db: InstanceType<typeof Bun.SQL>;
let store: TaskStore;
let currentTime: number;

beforeEach(() => {
	currentTime = 1_000;
	db = new Bun.SQL("sqlite://:memory:");
	store = new TaskStore({
		db,
		dialect: "sqlite",
		now: () => currentTime++,
	});
});

afterEach(async () => {
	await db.close();
});

describe("TaskStore", () => {
	test("creates the expected task schema and indexes", async () => {
		await store.ready();

		const columns = await db<TableInfoRow[]>`PRAGMA table_info(tasks)`;
		expect(columns.map((column) => column.name)).toEqual([
			"id",
			"user_id",
			"thread_id_created",
			"thread_id_completed",
			"list_name",
			"title",
			"note",
			"status",
			"status_reason",
			"created_at",
			"updated_at",
			"completed_at",
			"dismissed_at",
		]);

		const indexes = await db<IndexListRow[]>`PRAGMA index_list(tasks)`;
		const indexNames = indexes.map((index) => index.name);
		expect(indexNames).toContain("idx_tasks_user_status_updated_at");
		expect(indexNames).toContain("idx_tasks_user_list_status");

		const updatedAtIndex =
			await db<IndexInfoRow[]>`PRAGMA index_info(idx_tasks_user_status_updated_at)`;
		expect(updatedAtIndex.map((column) => column.name)).toEqual([
			"user_id",
			"status",
			"updated_at",
		]);

		const listIndex =
			await db<IndexInfoRow[]>`PRAGMA index_info(idx_tasks_user_list_status)`;
		expect(listIndex.map((column) => column.name)).toEqual([
			"user_id",
			"list_name",
			"status",
		]);
	});

	test("adds tasks and lists them per caller", async () => {
		const first = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Ship task store",
			note: "Before lunch",
		});
		const second = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-b",
			listName: "backlog",
			title: "Write follow-up tests",
		});
		await store.addTask({
			userId: "telegram:2",
			threadIdCreated: "thread-c",
			listName: "today",
			title: "Other caller task",
		});

		expect(first.threadIdCreated).toBe("thread-a");
		expect(first.threadIdCompleted).toBeNull();
		expect(first.listName).toBe("today");
		expect(first.note).toBe("Before lunch");
		expect(first.status).toBe("active");

		const userOneTasks = await store.listTasksForUser("telegram:1");
		expect(userOneTasks.map((task) => task.id)).toEqual([second.id, first.id]);

		const todayTasks = await store.listTasksForUser("telegram:1", {
			listName: "today",
		});
		expect(todayTasks.map((task) => task.id)).toEqual([first.id]);

		const otherCallerTasks = await store.listTasksForUser("telegram:2");
		expect(otherCallerTasks).toHaveLength(1);
		expect(otherCallerTasks[0].title).toBe("Other caller task");
	});

	test("normalizes required task fields and drops blank optional fields", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "  today  ",
			title: "  Ship task store  ",
			note: "   ",
		});

		expect(task.listName).toBe("today");
		expect(task.title).toBe("Ship task store");
		expect(task.note).toBeNull();

		await expect(
			store.addTask({
				userId: "telegram:1",
				threadIdCreated: "thread-b",
				listName: "   ",
				title: "Valid title",
			}),
		).rejects.toThrow("Task list name cannot be empty.");
		await expect(
			store.addTask({
				userId: "telegram:1",
				threadIdCreated: "thread-c",
				listName: "today",
				title: "   ",
			}),
		).rejects.toThrow("Task title cannot be empty.");
	});

	test("completes active tasks for the owning caller only", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Close loop",
		});

		const blocked = await store.completeTask({
			taskId: task.id,
			userId: "telegram:2",
			threadIdCompleted: "thread-z",
		});
		expect(blocked).toBeNull();

		const completed = await store.completeTask({
			taskId: task.id,
			userId: "telegram:1",
			threadIdCompleted: "thread-done",
		});
		expect(completed).not.toBeNull();
		expect(completed?.status).toBe("completed");
		expect(completed?.threadIdCompleted).toBe("thread-done");
		expect(completed?.completedAt).not.toBeNull();
		expect(completed?.dismissedAt).toBeNull();

		expect(await store.listActiveTasks("telegram:1")).toHaveLength(0);
		const completedTasks = await store.listTasksForUser("telegram:1", {
			status: "completed",
		});
		expect(completedTasks).toHaveLength(1);
		expect(completedTasks[0].id).toBe(task.id);

		const secondAttempt = await store.completeTask({
			taskId: task.id,
			userId: "telegram:1",
			threadIdCompleted: "thread-again",
		});
		expect(secondAttempt).toBeNull();
	});

	test("dismisses active tasks for the owning caller only", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "backlog",
			title: "Drop stale work",
			note: "No longer needed",
		});

		const dismissed = await store.dismissTask({
			taskId: task.id,
			userId: "telegram:1",
			reason: "superseded",
		});
		expect(dismissed).not.toBeNull();
		expect(dismissed?.status).toBe("dismissed");
		expect(dismissed?.statusReason).toBe("superseded");
		expect(dismissed?.completedAt).toBeNull();
		expect(dismissed?.dismissedAt).not.toBeNull();
		expect(dismissed?.threadIdCompleted).toBeNull();

		expect(await store.listActiveTasks("telegram:1")).toHaveLength(0);
		const dismissedTasks = await store.listTasksForUser("telegram:1", {
			status: "dismissed",
		});
		expect(dismissedTasks).toHaveLength(1);
		expect(dismissedTasks[0].title).toBe("Drop stale work");

		const otherCaller = await store.addTask({
			userId: "telegram:2",
			threadIdCreated: "thread-b",
			listName: "today",
			title: "Keep this task",
		});
		expect(
			await store.dismissTask({
				taskId: otherCaller.id,
				userId: "telegram:1",
				reason: "not mine",
			}),
		).toBeNull();
		expect(await store.getTask(otherCaller.id, "telegram:2")).toMatchObject({
			id: otherCaller.id,
			status: "active",
		});
	});

	test("normalizes dismissal reasons", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "backlog",
			title: "Drop stale work",
		});

		const dismissed = await store.dismissTask({
			taskId: task.id,
			userId: "telegram:1",
			reason: "  superseded by new scope  ",
		});
		expect(dismissed?.statusReason).toBe("superseded by new scope");

		const second = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-b",
			listName: "backlog",
			title: "Blank reason task",
		});
		const blankReason = await store.dismissTask({
			taskId: second.id,
			userId: "telegram:1",
			reason: "   ",
		});
		expect(blankReason?.statusReason).toBeNull();
	});

	test("lists recently completed tasks by caller and recency window", async () => {
		currentTime = 10_000;
		const recentTask = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-recent",
			listName: "today",
			title: "Recent completion",
		});
		await store.completeTask({
			taskId: recentTask.id,
			userId: "telegram:1",
			threadIdCompleted: "thread-recent-done",
		});

		currentTime = 2_000;
		const staleTask = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-stale",
			listName: "backlog",
			title: "Stale completion",
		});
		await store.completeTask({
			taskId: staleTask.id,
			userId: "telegram:1",
			threadIdCompleted: "thread-stale-done",
		});

		currentTime = 11_000;
		const otherCallerTask = await store.addTask({
			userId: "telegram:2",
			threadIdCreated: "thread-other",
			listName: "today",
			title: "Other caller completion",
		});
		await store.completeTask({
			taskId: otherCallerTask.id,
			userId: "telegram:2",
			threadIdCompleted: "thread-other-done",
		});

		const recentTasks = await store.listRecentlyCompletedTasks("telegram:1", {
			completedSince: 9_000,
		});
		expect(recentTasks.map((task) => task.title)).toEqual(["Recent completion"]);
		expect(recentTasks[0]?.threadIdCompleted).toBe("thread-recent-done");
	});

	test("renders a compact active-task snapshot", async () => {
		await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "today",
			title: "Ship task tools",
			note: "Keep the output compact",
		});
		await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-b",
			listName: "backlog",
			title: "Follow up later",
		});

		const snapshot = await store.composeActiveTaskSnapshot("telegram:1", {
			limit: 1,
		});
		expect(snapshot).toContain("## Active tasks");
		expect(snapshot).toContain("backlog: Follow up later");
		expect(snapshot).toContain("1 more active task");

		expect(formatActiveTaskSnapshot([])).toBe("## Active tasks\n- None.");
	});

	test("uses the default compact limit and reports overflow", async () => {
		for (let index = 1; index <= 14; index += 1) {
			await store.addTask({
				userId: "telegram:1",
				threadIdCreated: `thread-${index}`,
				listName: "today",
				title: `Task ${index}`,
			});
		}

		const snapshot = await store.composeActiveTaskSnapshot("telegram:1");
		const taskLines = snapshot
			.split("\n")
			.filter((line) => line.startsWith("- ["));
		expect(taskLines).toHaveLength(12);
		expect(snapshot).toContain("2 more active task(s).");
	});
});
