import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { TimerStore } from "./store";
import { createTimerTools } from "./tools";

let db: InstanceType<typeof Bun.SQL>;
let store: TimerStore;
let currentTime: number;
let readMdFileMock: (path: string) => Promise<string>;
let computeNextRunMock: (
	cronExpression: string,
	timezone: string,
	fromDate?: Date,
) => number;
const callerId = "telegram:1";

function createMockStore() {
	return {
		create: vi.fn<typeof store.create>(),
		findByUser: vi.fn<typeof store.findByUser>(),
		getById: vi.fn<typeof store.getById>(),
		update: vi.fn<typeof store.update>(),
		delete: vi.fn<typeof store.delete>(),
	};
}

beforeEach(() => {
	currentTime = 1_000;
	db = new Bun.SQL("sqlite://:memory:");
	store = new TimerStore({
		db,
		dialect: "sqlite",
		now: () => currentTime++,
	});
	readMdFileMock = vi.fn().mockResolvedValue("# Daily News Prompt\nGive me the latest news.");
	computeNextRunMock = vi.fn().mockReturnValue(2000);
});

afterEach(async () => {
	await db.close();
});

describe("TimerTools", () => {
	describe("create_timer", () => {
		test("creates a valid timer", async () => {
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const createTool = tools.find((t) => t.name === "create_timer")!;

			const result = await createTool.invoke({
				mdFilePath: "/memory/daily-news.md",
				cronExpression: "0 10 * * 1-5",
			});

			expect(result).toContain("Timer set");
			expect(result).toContain("daily-news.md");
			expect(result).toContain("0 10 * * 1-5");
			expect(result).toContain("Timer ID:");
		});

		test("creates timer with relative memory path", async () => {
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const createTool = tools.find((t) => t.name === "create_timer")!;

			const result = await createTool.invoke({
				mdFilePath: "daily-news.md",
				cronExpression: "0 10 * * 1-5",
			});

			expect(result).toContain("Timer set");
		});

		test("returns error for invalid cron expression", async () => {
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const createTool = tools.find((t) => t.name === "create_timer")!;

			const result = await createTool.invoke({
				mdFilePath: "/memory/daily-news.md",
				cronExpression: "not-a-cron",
			});

			expect(result).toBe(
				"Error: Invalid schedule. Try '0 10 * * 1-5' for every workday at 10 AM.",
			);
		});

		test("returns error for md file path outside /memory/", async () => {
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const createTool = tools.find((t) => t.name === "create_timer")!;

			const result = await createTool.invoke({
				mdFilePath: "/etc/passwd",
				cronExpression: "0 10 * * 1-5",
			});

			expect(result).toBe("Error: Memory file path must be inside /memory/");
		});

		test("returns error for path with traversal attempt", async () => {
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const createTool = tools.find((t) => t.name === "create_timer")!;

			const result = await createTool.invoke({
				mdFilePath: "/memory/../etc/passwd",
				cronExpression: "0 10 * * 1-5",
			});

			expect(result).toBe("Error: Memory file path must be inside /memory/");
		});

		test("returns error when md file not found", async () => {
			readMdFileMock = vi.fn().mockRejectedValue(new Error("File not found"));
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const createTool = tools.find((t) => t.name === "create_timer")!;

			const result = await createTool.invoke({
				mdFilePath: "/memory/nonexistent.md",
				cronExpression: "0 10 * * 1-5",
			});

			expect(result).toBe("Error: Memory file not found: /memory/nonexistent.md");
		});

		test("uses provided timezone when specified", async () => {
			const createSpy = vi.spyOn(store, "create");
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const createTool = tools.find((t) => t.name === "create_timer")!;

			await createTool.invoke({
				mdFilePath: "/memory/daily-news.md",
				cronExpression: "0 10 * * 1-5",
				timezone: "America/New_York",
			});

			expect(createSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					timezone: "America/New_York",
				}),
			);
			expect(computeNextRunMock).toHaveBeenCalledWith(
				"0 10 * * 1-5",
				"America/New_York",
			);
		});

		test("stores provided chat id separately from user id", async () => {
			const createSpy = vi.spyOn(store, "create");
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
				chatId: "1",
			});
			const createTool = tools.find((t) => t.name === "create_timer")!;

			await createTool.invoke({
				mdFilePath: "/memory/daily-news.md",
				cronExpression: "0 10 * * 1-5",
			});

			expect(createSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "telegram:1",
					chatId: "1",
				}),
			);
		});

		test("returns error for invalid timezone", async () => {
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const createTool = tools.find((t) => t.name === "create_timer")!;

			const result = await createTool.invoke({
				mdFilePath: "/memory/daily-news.md",
				cronExpression: "0 10 * * 1-5",
				timezone: "Mars/Base",
			});

			expect(result).toBe("Error: Invalid timezone: Mars/Base");
			expect(computeNextRunMock).not.toHaveBeenCalled();
		});
	});

	describe("list_timers", () => {
		test("returns no timers when list is empty", async () => {
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const listTool = tools.find((t) => t.name === "list_timers")!;

			const result = await listTool.invoke({});

			expect(result).toBe("No active timers.");
		});

		test("returns formatted list of timers", async () => {
			await store.create({
				userId: callerId,
				chatId: callerId,
				mdFilePath: "timer-a.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});
			await store.create({
				userId: callerId,
				chatId: callerId,
				mdFilePath: "timer-b.md",
				cronExpression: "0 12 * * *",
				timezone: "UTC",
				nextRunAt: 3000,
			});

			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const listTool = tools.find((t) => t.name === "list_timers")!;

			const result = await listTool.invoke({});

			expect(result).toContain("timer-a.md");
			expect(result).toContain("timer-b.md");
			expect(result).toContain("0 10 * * *");
			expect(result).toContain("0 12 * * *");
		});
	});

	describe("update_timer", () => {
		test("updates timer cron expression", async () => {
			const timer = await store.create({
				userId: callerId,
				chatId: callerId,
				mdFilePath: "timer.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const updateTool = tools.find((t) => t.name === "update_timer")!;

			const result = await updateTool.invoke({
				timerId: timer.id,
				cronExpression: "0 14 * * *",
			});

			expect(result).toContain("updated");
			expect(result).toContain("0 14 * * *");
		});

		test("updates timer timezone", async () => {
			const timer = await store.create({
				userId: callerId,
				chatId: callerId,
				mdFilePath: "timer.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const updateTool = tools.find((t) => t.name === "update_timer")!;

			const result = await updateTool.invoke({
				timerId: timer.id,
				timezone: "America/New_York",
			});

			expect(result).toContain("updated");
			expect(result).toContain("America/New_York");

			const updated = await store.getById(timer.id);
			expect(updated?.nextRunAt).toBe(2000);
			expect(updated?.lastRunAt).toBeNull();
			expect(computeNextRunMock).toHaveBeenCalledWith(
				"0 10 * * *",
				"America/New_York",
			);
		});

		test("returns error for invalid timezone in update", async () => {
			const timer = await store.create({
				userId: callerId,
				chatId: callerId,
				mdFilePath: "timer.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const updateTool = tools.find((t) => t.name === "update_timer")!;

			const result = await updateTool.invoke({
				timerId: timer.id,
				timezone: "Mars/Base",
			});

			expect(result).toBe("Error: Invalid timezone: Mars/Base");
			const unchanged = await store.getById(timer.id);
			expect(unchanged?.timezone).toBe("UTC");
			expect(unchanged?.nextRunAt).toBe(2000);
		});

		test("updates timer enabled state", async () => {
			const timer = await store.create({
				userId: callerId,
				chatId: callerId,
				mdFilePath: "timer.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const updateTool = tools.find((t) => t.name === "update_timer")!;

			const result = await updateTool.invoke({
				timerId: timer.id,
				enabled: false,
			});

			expect(result).toContain("updated");
			expect(result).toContain("enabled changed to false");
		});

		test("returns error for non-owned timer", async () => {
			const timer = await store.create({
				userId: "telegram:1",
				chatId: "telegram:1",
				mdFilePath: "timer.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId: "telegram:999",
			});
			const updateTool = tools.find((t) => t.name === "update_timer")!;

			const result = await updateTool.invoke({
				timerId: timer.id,
				cronExpression: "0 14 * * *",
			});

			expect(result).toContain("not found or access denied");
		});

		test("returns error for invalid cron in update", async () => {
			const timer = await store.create({
				userId: callerId,
				chatId: callerId,
				mdFilePath: "timer.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const updateTool = tools.find((t) => t.name === "update_timer")!;

			const result = await updateTool.invoke({
				timerId: timer.id,
				cronExpression: "invalid-cron",
			});

			expect(result).toContain("Invalid schedule");
		});

		test("returns 'No changes provided' for empty update", async () => {
			const timer = await store.create({
				userId: callerId,
				chatId: callerId,
				mdFilePath: "timer.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const updateTool = tools.find((t) => t.name === "update_timer")!;

			const result = await updateTool.invoke({
				timerId: timer.id,
			});

			expect(result).toBe("No changes provided.");
		});
	});

	describe("delete_timer", () => {
		test("deletes owned timer", async () => {
			const timer = await store.create({
				userId: callerId,
				chatId: callerId,
				mdFilePath: "timer.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const deleteTool = tools.find((t) => t.name === "delete_timer")!;

			const result = await deleteTool.invoke({ timerId: timer.id });

			expect(result).toBe("Timer deleted.");

			const found = await store.getById(timer.id);
			expect(found).toBeNull();
		});

		test("returns error when deleting non-owned timer", async () => {
			const timer = await store.create({
				userId: "telegram:1",
				chatId: "telegram:1",
				mdFilePath: "timer.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId: "telegram:999",
			});
			const deleteTool = tools.find((t) => t.name === "delete_timer")!;

			const result = await deleteTool.invoke({ timerId: timer.id });

			expect(result).toContain("not found or access denied");

			const found = await store.getById(timer.id);
			expect(found).not.toBeNull();
		});

		test("returns error when deleting non-existent timer", async () => {
			const tools = createTimerTools(store, {
				timezone: "UTC",
				computeNextRun: computeNextRunMock,
				readMdFile: readMdFileMock,
				callerId,
			});
			const deleteTool = tools.find((t) => t.name === "delete_timer")!;

			const result = await deleteTool.invoke({ timerId: "non-existent-id" });

			expect(result).toContain("not found or access denied");
		});
	});
});
