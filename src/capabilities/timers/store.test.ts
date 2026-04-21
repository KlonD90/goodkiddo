import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TimerStore } from "./store";

type IndexListRow = {
	seq: number;
	name: string;
	unique: 0 | 1;
	origin: string;
	partial: 0 | 1;
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
let store: TimerStore;
let currentTime: number;

beforeEach(() => {
	currentTime = 1_000;
	db = new Bun.SQL("sqlite://:memory:");
	store = new TimerStore({
		db,
		dialect: "sqlite",
		now: () => currentTime++,
	});
});

afterEach(async () => {
	await db.close();
});

describe("TimerStore", () => {
	test("creates the expected timers schema and indexes", async () => {
		await store.ready();

		const columns = await db<TableInfoRow[]>`PRAGMA table_info(timers)`;
		expect(columns.map((column) => column.name)).toEqual([
			"id",
			"user_id",
			"chat_id",
			"md_file_path",
			"cron_expression",
			"timezone",
			"enabled",
			"last_run_at",
			"last_error",
			"consecutive_failures",
			"next_run_at",
			"created_at",
		]);

		const indexes = await db<IndexListRow[]>`PRAGMA index_list(timers)`;
		const indexNames = indexes.map((index) => index.name);
		expect(indexNames).toContain("idx_timers_enabled_next_run_at");
	});

	test("creates a timer and returns the full record", async () => {
		const timer = await store.create({
			userId: "telegram:1",
			chatId: "telegram:1",
			mdFilePath: "daily-news.md",
			cronExpression: "0 10 * * 1-5",
			timezone: "UTC",
			nextRunAt: 2000,
		});

		expect(timer.id).toBeDefined();
		expect(timer.userId).toBe("telegram:1");
		expect(timer.chatId).toBe("telegram:1");
		expect(timer.mdFilePath).toBe("daily-news.md");
		expect(timer.cronExpression).toBe("0 10 * * 1-5");
		expect(timer.timezone).toBe("UTC");
		expect(timer.enabled).toBe(true);
		expect(timer.lastRunAt).toBeNull();
		expect(timer.lastError).toBeNull();
		expect(timer.consecutiveFailures).toBe(0);
		expect(timer.nextRunAt).toBe(2000);
		expect(timer.createdAt).toBeGreaterThan(0);
	});

	test("finds due timers ordered by next_run_at", async () => {
		await store.create({
			userId: "telegram:1",
			chatId: "telegram:1",
			mdFilePath: "timer-a.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
			nextRunAt: 500,
		});
		await store.create({
			userId: "telegram:2",
			chatId: "telegram:2",
			mdFilePath: "timer-b.md",
			cronExpression: "0 12 * * *",
			timezone: "UTC",
			nextRunAt: 100,
		});
		await store.create({
			userId: "telegram:3",
			chatId: "telegram:3",
			mdFilePath: "timer-c.md",
			cronExpression: "0 14 * * *",
			timezone: "UTC",
			nextRunAt: 3000,
		});

		currentTime = 1500;
		const due = await store.findDue();

		expect(due).toHaveLength(2);
		expect(due[0].mdFilePath).toBe("timer-b.md");
		expect(due[1].mdFilePath).toBe("timer-a.md");
	});

	test("finds timers by user", async () => {
		await store.create({
			userId: "telegram:1",
			chatId: "telegram:1",
			mdFilePath: "timer-a.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
			nextRunAt: 2000,
		});
		await store.create({
			userId: "telegram:1",
			chatId: "telegram:1",
			mdFilePath: "timer-b.md",
			cronExpression: "0 12 * * *",
			timezone: "UTC",
			nextRunAt: 2000,
		});
		await store.create({
			userId: "telegram:2",
			chatId: "telegram:2",
			mdFilePath: "timer-c.md",
			cronExpression: "0 14 * * *",
			timezone: "UTC",
			nextRunAt: 2000,
		});

		const user1Timers = await store.findByUser("telegram:1");
		expect(user1Timers).toHaveLength(2);

		const user2Timers = await store.findByUser("telegram:2");
		expect(user2Timers).toHaveLength(1);
	});

	test("updates timer cron and recomputes next_run_at via touchRun", async () => {
		const timer = await store.create({
			userId: "telegram:1",
			chatId: "telegram:1",
			mdFilePath: "timer.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
			nextRunAt: 2000,
		});

		const updated = await store.update(timer.id, "telegram:1", {
			cronExpression: "0 14 * * *",
		});

		expect(updated).not.toBeNull();
		expect(updated?.cronExpression).toBe("0 14 * * *");
	});

	test("update rejected for non-owner", async () => {
		const timer = await store.create({
			userId: "telegram:1",
			chatId: "telegram:1",
			mdFilePath: "timer.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
			nextRunAt: 2000,
		});

		const updated = await store.update(timer.id, "telegram:2", {
			cronExpression: "0 14 * * *",
		});

		expect(updated).toBeNull();
	});

	test("deletes timer by owner", async () => {
		const timer = await store.create({
			userId: "telegram:1",
			chatId: "telegram:1",
			mdFilePath: "timer.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
			nextRunAt: 2000,
		});

		const deleted = await store.delete(timer.id, "telegram:1");
		expect(deleted).toBe(true);

		const found = await store.getById(timer.id);
		expect(found).toBeNull();
	});

	test("delete rejected for non-owner", async () => {
		const timer = await store.create({
			userId: "telegram:1",
			chatId: "telegram:1",
			mdFilePath: "timer.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
			nextRunAt: 2000,
		});

		const deleted = await store.delete(timer.id, "telegram:2");
		expect(deleted).toBe(false);

		const found = await store.getById(timer.id);
		expect(found).not.toBeNull();
	});

	test("touchRun resets failures and updates next_run_at", async () => {
		const timer = await store.create({
			userId: "telegram:1",
			chatId: "telegram:1",
			mdFilePath: "timer.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
			nextRunAt: 2000,
		});

		await store.touchError(timer.id, "Some error");
		await store.touchError(timer.id, "Another error");

		const afterErrors = await store.getById(timer.id);
		expect(afterErrors?.consecutiveFailures).toBe(2);
		expect(afterErrors?.lastError).toBe("Another error");

		await store.touchRun(timer.id, 5000);

		const afterRun = await store.getById(timer.id);
		expect(afterRun?.consecutiveFailures).toBe(0);
		expect(afterRun?.lastError).toBeNull();
		expect(afterRun?.lastRunAt).not.toBeNull();
		expect(afterRun?.nextRunAt).toBe(5000);
	});

	test("touchError increments consecutive_failures counter", async () => {
		const timer = await store.create({
			userId: "telegram:1",
			chatId: "telegram:1",
			mdFilePath: "timer.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
			nextRunAt: 2000,
		});

		const count1 = await store.touchError(timer.id, "Error 1");
		expect(count1).toBe(1);

		const count2 = await store.touchError(timer.id, "Error 2");
		expect(count2).toBe(2);

		const count3 = await store.touchError(timer.id, "Error 3");
		expect(count3).toBe(3);

		const after = await store.getById(timer.id);
		expect(after?.consecutiveFailures).toBe(3);
		expect(after?.lastError).toBe("Error 3");
	});
});
