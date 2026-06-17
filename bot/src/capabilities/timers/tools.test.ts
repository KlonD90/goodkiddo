import { describe, expect, test } from "bun:test";
import type {
	CreateTimerParams,
	TimerRecord,
	TimerStore,
	UpdateTimerParams,
} from "./store.js";
import { createTimerTools } from "./tools.js";

function createMockStore(): TimerStore {
	const timers = new Map<string, TimerRecord>();
	let idCounter = 0;

	return {
		async create(params: CreateTimerParams): Promise<TimerRecord> {
			idCounter += 1;
			const id = `timer-${idCounter}`;
			const now = Date.now();
			const timer: TimerRecord = {
				id,
				userId: params.userId,
				chatId: params.chatId,
				mdFilePath: params.mdFilePath ?? "",
				cronExpression: params.cronExpression ?? "",
				kind: params.kind ?? "always",
				message: params.message ?? null,
				notify: params.notify ?? "verbose",
				timezone: params.timezone,
				enabled: true,
				lastRunAt: null,
				lastError: null,
				consecutiveFailures: 0,
				nextRunAt: params.nextRunAt,
				createdAt: now,
			};
			timers.set(id, timer);
			return timer;
		},
		async findByUser(userId: string): Promise<TimerRecord[]> {
			return Array.from(timers.values()).filter((t) => t.userId === userId);
		},
		async getById(id: string): Promise<TimerRecord | null> {
			return timers.get(id) ?? null;
		},
		async update(
			id: string,
			_userId: string,
			updates: UpdateTimerParams,
		): Promise<TimerRecord | null> {
			const existing = timers.get(id);
			if (!existing) return null;
			const updated = { ...existing, ...updates };
			timers.set(id, updated);
			return updated;
		},
		async delete(id: string): Promise<boolean> {
			return timers.delete(id);
		},
		async findDue(): Promise<TimerRecord[]> {
			return [];
		},
		async touchRun(): Promise<void> {},
		async touchError(): Promise<number> {
			return 0;
		},
		async ready(): Promise<void> {},
		close(): void {},
	} as unknown as TimerStore;
}

function createTools(
	store: TimerStore,
	defaultNotifyMode = "summary" as const,
) {
	return createTimerTools(store, {
		computeNextRun: (cron, timezone) => {
			const expr = new Date();
			expr.setMinutes(expr.getMinutes() + 1);
			return expr.getTime();
		},
		readMdFile: async (path) => `# ${path}`,
		callerId: "telegram:1",
		chatId: "123",
		defaultNotifyMode,
	});
}

describe("timer tools", () => {
	test("create_timer defaults notify mode from options", async () => {
		const store = createMockStore();
		const tools = createTools(store, "summary");
		const createTool = tools.find((t) => t.name === "create_timer")!;

		const result = await createTool.invoke({
			type: "always",
			mdFilePath: "daily.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
		});

		expect(result).toContain("Timer ID: timer-1");
		const timers = await store.findByUser("telegram:1");
		expect(timers).toHaveLength(1);
		expect(timers[0]?.notify).toBe("summary");
	});

	test("create_timer accepts explicit notify mode", async () => {
		const store = createMockStore();
		const tools = createTools(store, "summary");
		const createTool = tools.find((t) => t.name === "create_timer")!;

		const result = await createTool.invoke({
			type: "always",
			mdFilePath: "daily.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
			notify: "silent",
		});

		expect(result).toContain("Timer ID: timer-1");
		const timers = await store.findByUser("telegram:1");
		expect(timers[0]?.notify).toBe("silent");
	});

	test("create_timer for one-time reminders stores notify mode", async () => {
		const store = createMockStore();
		const tools = createTools(store, "summary");
		const createTool = tools.find((t) => t.name === "create_timer")!;

		const result = await createTool.invoke({
			type: "once",
			message: "Check deploy",
			runAtUtc: new Date(Date.now() + 60_000).toISOString(),
			notify: "errors_only",
		});

		expect(result).toContain("Timer ID: timer-1");
		const timers = await store.findByUser("telegram:1");
		expect(timers[0]?.notify).toBe("errors_only");
	});

	test("update_timer changes notify mode", async () => {
		const store = createMockStore();
		const tools = createTools(store, "summary");
		const createTool = tools.find((t) => t.name === "create_timer")!;
		const updateTool = tools.find((t) => t.name === "update_timer")!;

		await createTool.invoke({
			type: "always",
			mdFilePath: "daily.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
		});

		const result = await updateTool.invoke({
			timerId: "timer-1",
			notify: "verbose",
		});

		expect(result).toContain("notify changed to verbose");
		const timers = await store.findByUser("telegram:1");
		expect(timers[0]?.notify).toBe("verbose");
	});

	test("list_timers displays notify mode for recurring timers", async () => {
		const store = createMockStore();
		const tools = createTools(store, "summary");
		const createTool = tools.find((t) => t.name === "create_timer")!;
		const listTool = tools.find((t) => t.name === "list_timers")!;

		await createTool.invoke({
			type: "always",
			mdFilePath: "daily.md",
			cronExpression: "0 10 * * *",
			timezone: "UTC",
		});

		const result = await listTool.invoke({});

		expect(result).toContain("notify=summary");
	});
});
