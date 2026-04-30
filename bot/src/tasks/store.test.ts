import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type AddTaskInput,
	formatActiveTaskSnapshot,
	TaskStore,
	type UpdateTaskMetadataInput,
} from "./store";

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

function createRecordingDb(): {
	db: InstanceType<typeof Bun.SQL>;
	statements: string[];
} {
	const statements: string[] = [];
	const db = ((strings: TemplateStringsArray) => {
		statements.push(strings.join(" ").replace(/\s+/g, " ").trim());
		return Promise.resolve([]);
	}) as unknown as InstanceType<typeof Bun.SQL>;
	return { db, statements };
}

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
			"due_at",
			"next_check_at",
			"priority",
			"loop_type",
			"source_context",
			"source_ref",
			"last_nudged_at",
			"nudge_count",
			"snoozed_until",
		]);

		const indexes = await db<IndexListRow[]>`PRAGMA index_list(tasks)`;
		const indexNames = indexes.map((index) => index.name);
		expect(indexNames).toContain("idx_tasks_user_status_updated_at");
		expect(indexNames).toContain("idx_tasks_user_list_status");

		const updatedAtIndex = await db<
			IndexInfoRow[]
		>`PRAGMA index_info(idx_tasks_user_status_updated_at)`;
		expect(updatedAtIndex.map((column) => column.name)).toEqual([
			"user_id",
			"status",
			"updated_at",
		]);

		const listIndex = await db<
			IndexInfoRow[]
		>`PRAGMA index_info(idx_tasks_user_list_status)`;
		expect(listIndex.map((column) => column.name)).toEqual([
			"user_id",
			"list_name",
			"status",
		]);
	});

	test("runs postgres metadata migration statements", async () => {
		const recording = createRecordingDb();
		const postgresStore = new TaskStore({
			db: recording.db,
			dialect: "postgres",
		});

		await postgresStore.ready();

		expect(recording.statements).toContain(
			"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_at BIGINT",
		);
		expect(recording.statements).toContain(
			"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_check_at BIGINT",
		);
		expect(recording.statements).toContain(
			"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3)",
		);
		expect(recording.statements).toContain(
			"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS loop_type TEXT CHECK(loop_type IS NULL OR loop_type IN ('deadline', 'client_followup', 'decision', 'watch', 'continuation', 'general'))",
		);
		expect(recording.statements).toContain(
			"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_context TEXT",
		);
		expect(recording.statements).toContain(
			"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_ref TEXT",
		);
		expect(recording.statements).toContain(
			"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_nudged_at BIGINT",
		);
		expect(recording.statements).toContain(
			"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS nudge_count INTEGER NOT NULL DEFAULT 0 CHECK(nudge_count >= 0)",
		);
		expect(recording.statements).toContain(
			"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS snoozed_until BIGINT",
		);
	});

	test("migrates legacy task tables with metadata defaults", async () => {
		const legacyDb = new Bun.SQL("sqlite://:memory:");
		await legacyDb`
			CREATE TABLE tasks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id TEXT NOT NULL,
				thread_id_created TEXT NOT NULL,
				thread_id_completed TEXT,
				list_name TEXT NOT NULL,
				title TEXT NOT NULL,
				note TEXT,
				status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'dismissed')),
				status_reason TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				dismissed_at INTEGER
			)
		`;
		await legacyDb`
			INSERT INTO tasks (
				user_id,
				thread_id_created,
				thread_id_completed,
				list_name,
				title,
				note,
				status,
				status_reason,
				created_at,
				updated_at,
				completed_at,
				dismissed_at
			) VALUES (
				'telegram:1',
				'thread-a',
				NULL,
				'today',
				'Legacy task',
				NULL,
				'active',
				NULL,
				100,
				100,
				NULL,
				NULL
			)
		`;

		const legacyStore = new TaskStore({
			db: legacyDb,
			dialect: "sqlite",
			now: () => currentTime++,
		});
		await legacyStore.ready();

		const migrated = await legacyStore.getTask(1, "telegram:1");
		expect(migrated).toMatchObject({
			title: "Legacy task",
			dueAt: null,
			nextCheckAt: null,
			priority: 0,
			loopType: null,
			sourceContext: null,
			sourceRef: null,
			lastNudgedAt: null,
			nudgeCount: 0,
			snoozedUntil: null,
		});
		await legacyDb.close();
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
		expect(first).toMatchObject({
			dueAt: null,
			nextCheckAt: null,
			priority: 0,
			loopType: null,
			sourceContext: null,
			sourceRef: null,
			lastNudgedAt: null,
			nudgeCount: 0,
			snoozedUntil: null,
		});

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

	test("persists task metadata during creation", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "follow-up",
			title: "Send client recap",
			note: "After kickoff",
			dueAt: 2_000,
			nextCheckAt: 1_500,
			priority: 2,
			loopType: "client_followup",
			sourceContext: "  kickoff transcript  ",
			sourceRef: "  msg:123  ",
			lastNudgedAt: 1_250,
			nudgeCount: 1,
			snoozedUntil: 1_400,
		});

		expect(task).toMatchObject({
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

	test("updates task metadata with partial updates and explicit clears", async () => {
		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-a",
			listName: "watch",
			title: "Watch contract status",
			dueAt: 2_000,
			nextCheckAt: 2_200,
			priority: 1,
			loopType: "watch",
			sourceContext: "contract tracker",
			sourceRef: "msg:123",
			lastNudgedAt: 1_800,
			nudgeCount: 1,
			snoozedUntil: 2_400,
		});

		const updated = await store.updateTaskMetadata({
			taskId: task.id,
			userId: "telegram:1",
			dueAt: null,
			nextCheckAt: 3_000,
			priority: 3,
			loopType: "decision",
			sourceContext: "  updated tracker row  ",
			sourceRef: "  msg:456  ",
			lastNudgedAt: 2_500,
			nudgeCount: 2,
			snoozedUntil: null,
		});

		expect(updated).toMatchObject({
			dueAt: null,
			nextCheckAt: 3_000,
			priority: 3,
			loopType: "decision",
			sourceContext: "updated tracker row",
			sourceRef: "msg:456",
			lastNudgedAt: 2_500,
			nudgeCount: 2,
			snoozedUntil: null,
		});
		expect(updated?.updatedAt).toBeGreaterThan(task.updatedAt);
		expect(await store.getTask(task.id, "telegram:1")).toMatchObject({
			dueAt: null,
			nextCheckAt: 3_000,
			priority: 3,
			loopType: "decision",
			sourceContext: "updated tracker row",
			sourceRef: "msg:456",
			lastNudgedAt: 2_500,
			nudgeCount: 2,
			snoozedUntil: null,
		});

		const partialInput: UpdateTaskMetadataInput = {
			taskId: task.id,
			userId: "telegram:1",
			priority: 2,
		};
		Object.assign(partialInput, {
			dueAt: undefined,
			sourceContext: undefined,
		});
		expect(await store.updateTaskMetadata(partialInput)).toMatchObject({
			dueAt: null,
			nextCheckAt: 3_000,
			priority: 2,
			loopType: "decision",
			sourceContext: "updated tracker row",
			sourceRef: "msg:456",
			lastNudgedAt: 2_500,
			nudgeCount: 2,
			snoozedUntil: null,
		});

		expect(
			await store.updateTaskMetadata({
				taskId: task.id,
				userId: "telegram:1",
				loopType: null,
				sourceRef: null,
			}),
		).toMatchObject({
			loopType: null,
			sourceRef: null,
		});
		expect(
			await store.updateTaskMetadata({
				taskId: task.id,
				userId: "telegram:2",
				priority: 0,
			}),
		).toBeNull();
	});

	test("rejects invalid task metadata values", async () => {
		const invalidLoopType =
			"unsupported" as unknown as AddTaskInput["loopType"];
		const invalidCreateCases: Array<{
			name: string;
			input: Partial<AddTaskInput>;
			message: string;
		}> = [
			{
				name: "dueAt",
				input: { dueAt: -1 },
				message: "Task due time must be a non-negative integer timestamp.",
			},
			{
				name: "nextCheckAt",
				input: { nextCheckAt: -1 },
				message:
					"Task next check time must be a non-negative integer timestamp.",
			},
			{
				name: "priority",
				input: { priority: 4 },
				message: "Task priority must be an integer from 0 to 3.",
			},
			{
				name: "loopType",
				input: { loopType: invalidLoopType },
				message: "Task loop type is not supported.",
			},
			{
				name: "lastNudgedAt",
				input: { lastNudgedAt: -1 },
				message:
					"Task last nudged time must be a non-negative integer timestamp.",
			},
			{
				name: "nudgeCount",
				input: { nudgeCount: -1 },
				message: "Task nudge count must be a non-negative integer.",
			},
			{
				name: "snoozedUntil",
				input: { snoozedUntil: -1 },
				message:
					"Task snoozed until time must be a non-negative integer timestamp.",
			},
		];

		for (const invalidCase of invalidCreateCases) {
			await expect(
				store.addTask({
					userId: "telegram:1",
					threadIdCreated: "thread-a",
					listName: "today",
					title: `Invalid ${invalidCase.name}`,
					...invalidCase.input,
				}),
			).rejects.toThrow(invalidCase.message);
		}

		const task = await store.addTask({
			userId: "telegram:1",
			threadIdCreated: "thread-b",
			listName: "today",
			title: "Invalid update",
		});
		const invalidUpdateCases: Array<{
			input: Omit<UpdateTaskMetadataInput, "taskId" | "userId">;
			message: string;
		}> = [
			{
				input: { dueAt: -1 },
				message: "Task due time must be a non-negative integer timestamp.",
			},
			{
				input: { nextCheckAt: -1 },
				message:
					"Task next check time must be a non-negative integer timestamp.",
			},
			{
				input: { priority: 4 },
				message: "Task priority must be an integer from 0 to 3.",
			},
			{
				input: {
					loopType:
						"unsupported" as unknown as UpdateTaskMetadataInput["loopType"],
				},
				message: "Task loop type is not supported.",
			},
			{
				input: { lastNudgedAt: -1 },
				message:
					"Task last nudged time must be a non-negative integer timestamp.",
			},
			{
				input: { nudgeCount: -1 },
				message: "Task nudge count must be a non-negative integer.",
			},
			{
				input: { snoozedUntil: -1 },
				message:
					"Task snoozed until time must be a non-negative integer timestamp.",
			},
		];

		for (const invalidCase of invalidUpdateCases) {
			await expect(
				store.updateTaskMetadata({
					taskId: task.id,
					userId: "telegram:1",
					...invalidCase.input,
				}),
			).rejects.toThrow(invalidCase.message);
		}
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
		expect(recentTasks.map((task) => task.title)).toEqual([
			"Recent completion",
		]);
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
