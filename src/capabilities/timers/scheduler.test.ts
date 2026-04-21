import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startScheduler, type SchedulerOptions } from "./scheduler";
import type { TimerStore } from "./store.js";

interface AsyncMockFn {
	(...args: unknown[]): Promise<unknown>;
	_calls: unknown[][];
	_mockValue: unknown;
}

function createAsyncMockFn(): AsyncMockFn {
	const calls: unknown[][] = [];
	const mockFn = ((...args: unknown[]) => {
		calls.push(args);
		return (mockFn as AsyncMockFn)._mockValue as Promise<unknown>;
	}) as AsyncMockFn;
	mockFn._calls = calls;
	mockFn._mockValue = undefined;
	return mockFn;
}

type MockStore = {
	[K in keyof TimerStore]: AsyncMockFn;
};

let mockStore: MockStore;
let mockReadMdFile: AsyncMockFn;
let mockOnTick: AsyncMockFn;
let mockNotifyUser: AsyncMockFn;
let schedulerHandle: { stop: () => void } | null = null;

function createMockStore(): MockStore {
	return {
		findDue: createAsyncMockFn(),
		findByUser: createAsyncMockFn(),
		getById: createAsyncMockFn(),
		create: createAsyncMockFn(),
		update: createAsyncMockFn(),
		delete: createAsyncMockFn(),
		touchRun: createAsyncMockFn(),
		touchError: createAsyncMockFn(),
		ready: createAsyncMockFn(),
		close: createAsyncMockFn(),
	};
}

function createTimer(overrides: Partial<Parameters<SchedulerOptions["onTick"]>[0]> = {}) {
	return {
		id: "timer-1",
		userId: "telegram:1",
		chatId: "telegram:1",
		mdFilePath: "test.md",
		cronExpression: "0 10 * * *",
		timezone: "UTC",
		enabled: true,
		lastRunAt: null,
		lastError: null,
		consecutiveFailures: 0,
		nextRunAt: 1000,
		createdAt: 100,
		...overrides,
	};
}

beforeEach(() => {
	mockStore = createMockStore();
	mockReadMdFile = createAsyncMockFn();
	mockOnTick = createAsyncMockFn();
	mockNotifyUser = createAsyncMockFn();
});

afterEach(() => {
	schedulerHandle?.stop();
	schedulerHandle = null;
});

describe("startScheduler", () => {
	test("fires due timers and calls onTick with prompt text", async () => {
		const timer = createTimer();
		mockStore.findDue._mockValue = Promise.resolve([timer]);
		mockReadMdFile._mockValue = Promise.resolve("Hello world");
		mockOnTick._mockValue = Promise.resolve(undefined);
		mockStore.touchRun._mockValue = Promise.resolve(undefined);

		schedulerHandle = startScheduler(mockStore as unknown as TimerStore, {
			intervalMs: 10_000_000,
			readMdFile: mockReadMdFile as (path: string) => Promise<string>,
			onTick: mockOnTick as (timer: Parameters<SchedulerOptions["onTick"]>[0], promptText: string) => Promise<void>,
			notifyUser: mockNotifyUser as (userId: string, message: string) => Promise<void>,
		});

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mockStore.findDue._calls.length).toBeGreaterThan(0);
		expect(mockReadMdFile._calls).toEqual([["test.md"]]);
		expect(mockOnTick._calls).toEqual([[timer, "Hello world"]]);
		expect(mockStore.touchRun._calls.length).toBe(1);
	});

	test("skips non-due timers (findDue returns empty)", async () => {
		mockStore.findDue._mockValue = Promise.resolve([]);

		schedulerHandle = startScheduler(mockStore as unknown as TimerStore, {
			intervalMs: 10_000_000,
			readMdFile: mockReadMdFile as (path: string) => Promise<string>,
			onTick: mockOnTick as (timer: Parameters<SchedulerOptions["onTick"]>[0], promptText: string) => Promise<void>,
			notifyUser: mockNotifyUser as (userId: string, message: string) => Promise<void>,
		});

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mockStore.findDue._calls.length).toBeGreaterThan(0);
		expect(mockReadMdFile._calls.length).toBe(0);
		expect(mockOnTick._calls.length).toBe(0);
	});

	test("handles onTick errors and calls touchError", async () => {
		const timer = createTimer();
		mockStore.findDue._mockValue = Promise.resolve([timer]);
		mockReadMdFile._mockValue = Promise.resolve("prompt");
		mockOnTick._mockValue = Promise.reject(new Error("LLM failed"));
		mockStore.touchError._mockValue = Promise.resolve(1);

		schedulerHandle = startScheduler(mockStore as unknown as TimerStore, {
			intervalMs: 10_000_000,
			readMdFile: mockReadMdFile as (path: string) => Promise<string>,
			onTick: mockOnTick as (timer: Parameters<SchedulerOptions["onTick"]>[0], promptText: string) => Promise<void>,
			notifyUser: mockNotifyUser as (userId: string, message: string) => Promise<void>,
		});

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mockStore.touchError._calls.length).toBe(1);
		expect(mockStore.touchError._calls[0][0]).toBe("timer-1");
		expect(mockStore.touchError._calls[0][1]).toBe("LLM failed");
		expect(typeof mockStore.touchError._calls[0][2]).toBe("number");
		expect(mockNotifyUser._calls.length).toBe(0);
	});

	test("notifies user after 3 consecutive failures", async () => {
		const timer = createTimer();
		mockStore.findDue._mockValue = Promise.resolve([timer]);
		mockReadMdFile._mockValue = Promise.resolve("prompt");
		mockOnTick._mockValue = Promise.reject(new Error("LLM failed"));
		mockStore.touchError._mockValue = Promise.resolve(3);

		schedulerHandle = startScheduler(mockStore as unknown as TimerStore, {
			intervalMs: 10_000_000,
			readMdFile: mockReadMdFile as (path: string) => Promise<string>,
			onTick: mockOnTick as (timer: Parameters<SchedulerOptions["onTick"]>[0], promptText: string) => Promise<void>,
			notifyUser: mockNotifyUser as (userId: string, message: string) => Promise<void>,
		});

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mockStore.touchError._calls.length).toBe(1);
		expect(mockNotifyUser._calls).toEqual([
			["telegram:1", expect.stringContaining("failed 3 times")],
		]);
	});

	test("md file not found causes timer deletion and user notification", async () => {
		const timer = createTimer({ mdFilePath: "/memory/deleted.md" });
		mockStore.findDue._mockValue = Promise.resolve([timer]);
		mockReadMdFile._mockValue = Promise.reject(new Error("File not found"));
		mockStore.delete._mockValue = Promise.resolve(true);

		schedulerHandle = startScheduler(mockStore as unknown as TimerStore, {
			intervalMs: 10_000_000,
			readMdFile: mockReadMdFile as (path: string) => Promise<string>,
			onTick: mockOnTick as (timer: Parameters<SchedulerOptions["onTick"]>[0], promptText: string) => Promise<void>,
			notifyUser: mockNotifyUser as (userId: string, message: string) => Promise<void>,
		});

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mockStore.delete._calls).toEqual([["timer-1", "telegram:1"]]);
		expect(mockNotifyUser._calls).toEqual([
			["telegram:1", "Timer for '/memory/deleted.md' was deleted because the memory file no longer exists."],
		]);
		expect(mockOnTick._calls.length).toBe(0);
	});

	test("stops the scheduler and clears interval", async () => {
		mockStore.findDue._mockValue = Promise.resolve([]);

		schedulerHandle = startScheduler(mockStore as unknown as TimerStore, {
			intervalMs: 10_000_000,
			readMdFile: mockReadMdFile as (path: string) => Promise<string>,
			onTick: mockOnTick as (timer: Parameters<SchedulerOptions["onTick"]>[0], promptText: string) => Promise<void>,
			notifyUser: mockNotifyUser as (userId: string, message: string) => Promise<void>,
		});

		const findDueCallsBefore = mockStore.findDue._calls.length;
		schedulerHandle?.stop();

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(mockStore.findDue._calls.length).toBe(findDueCallsBefore);
	});
});
