import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tool } from "langchain";
import { z } from "zod";
import type {
	ApprovalBroker,
	ApprovalOutcome,
	ApprovalRequest,
} from "../permissions/approval";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import { wrapToolWithGuard } from "./guard";
import type { StatusEmitter } from "./status_emitter";

class FakeBroker implements ApprovalBroker {
	public lastRequest: ApprovalRequest | null = null;
	constructor(private readonly outcome: ApprovalOutcome) {}
	async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
		this.lastRequest = request;
		return this.outcome;
	}
}

class FakeStatusEmitter implements StatusEmitter {
	public calls: Array<{ callerId: string; message: string }> = [];
	public shouldThrow = false;
	async emit(callerId: string, message: string): Promise<void> {
		if (this.shouldThrow) {
			throw new Error("emitter error");
		}
		this.calls.push({ callerId, message });
	}
}

const caller: Caller = {
	id: "cli:test",
	entrypoint: "cli",
	externalId: "test",
};

let db: InstanceType<typeof Bun.SQL>;
let store: PermissionsStore;

const sampleTool = () =>
	tool(async (input: { value: string }) => `ran:${input.value}`, {
		name: "sample",
		description: "Sample tool for tests.",
		schema: z.object({ value: z.string() }),
	});

beforeEach(async () => {
	db = new Bun.SQL("sqlite://:memory:");
	store = new PermissionsStore({ db, dialect: "sqlite" });
	await store.upsertUser({ entrypoint: "cli", externalId: "test" });
});

afterEach(async () => {
	await db.close();
});

describe("wrapToolWithGuard", () => {
	test("default-allow runs non-execute tools without consulting broker", async () => {
		const broker = new FakeBroker("deny-once");
		const wrapped = wrapToolWithGuard(sampleTool(), {
			caller,
			store,
			broker,
		});
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			value: "y",
		});
		expect(result).toBe("ran:y");
		expect(broker.lastRequest).toBeNull();
	});

	test("allow rule passes through", async () => {
		await store.upsertRule(caller.id, {
			priority: 100,
			toolName: "sample",
			args: null,
			decision: "allow",
		});
		const broker = new FakeBroker("deny-once");
		const wrapped = wrapToolWithGuard(sampleTool(), {
			caller,
			store,
			broker,
		});
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			value: "x",
		});
		expect(result).toBe("ran:x");
		expect(broker.lastRequest).toBeNull();
	});

	test("deny rule blocks without consulting broker", async () => {
		await store.upsertRule(caller.id, {
			priority: 100,
			toolName: "sample",
			args: null,
			decision: "deny",
		});
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(sampleTool(), {
			caller,
			store,
			broker,
		});
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			value: "x",
		});
		expect(result).toMatch(/Permission denied by policy/);
		expect(broker.lastRequest).toBeNull();
	});

	test("execute tools still consult broker by default; approve-once runs", async () => {
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { value: string }) => `ran:${input.value}`, {
				name: "execute_workspace",
				description: "Execute tool for tests.",
				schema: z.object({ value: z.string() }),
			}),
			{
				caller,
				store,
				broker,
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			value: "y",
		});
		expect(result).toBe("ran:y");
		expect(broker.lastRequest?.toolName).toBe("execute_workspace");
	});

	test("execute tools default-ask + deny-once returns denial", async () => {
		const broker = new FakeBroker("deny-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { value: string }) => `ran:${input.value}`, {
				name: "execute_workspace",
				description: "Execute tool for tests.",
				schema: z.object({ value: z.string() }),
			}),
			{
				caller,
				store,
				broker,
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			value: "z",
		});
		expect(result).toMatch(/Permission denied by user/);
	});
});

describe("wrapToolWithGuard status emission", () => {
	test("emits status on successful tool execution in english", async () => {
		const emitter = new FakeStatusEmitter();
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { file_path: string }) => `ran:${input.file_path}`, {
				name: "read_file",
				description: "Read a file",
				schema: z.object({ file_path: z.string() }),
			}),
			{
				caller,
				store,
				broker,
				statusEmitter: emitter,
				locale: "en",
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			file_path: "/src/index.ts",
		});
		expect(result).toBe("ran:/src/index.ts");
		expect(emitter.calls).toHaveLength(1);
		expect(emitter.calls[0].callerId).toBe("cli:test");
		expect(emitter.calls[0].message).toBe("Reading /src/index.ts");
	});

	test("emits status on successful tool execution in russian", async () => {
		const emitter = new FakeStatusEmitter();
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { file_path: string }) => `ran:${input.file_path}`, {
				name: "read_file",
				description: "Read a file",
				schema: z.object({ file_path: z.string() }),
			}),
			{
				caller,
				store,
				broker,
				statusEmitter: emitter,
				locale: "ru",
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			file_path: "/src/index.ts",
		});
		expect(result).toBe("ran:/src/index.ts");
		expect(emitter.calls).toHaveLength(1);
		expect(emitter.calls[0].message).toBe("Чтение /src/index.ts");
	});

	test("emits status on successful tool execution in spanish", async () => {
		const emitter = new FakeStatusEmitter();
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { file_path: string }) => `ran:${input.file_path}`, {
				name: "read_file",
				description: "Read a file",
				schema: z.object({ file_path: z.string() }),
			}),
			{
				caller,
				store,
				broker,
				statusEmitter: emitter,
				locale: "es",
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			file_path: "/src/index.ts",
		});
		expect(result).toBe("ran:/src/index.ts");
		expect(emitter.calls).toHaveLength(1);
		expect(emitter.calls[0].message).toBe("Leyendo /src/index.ts");
	});

	test("no status emitted when tool has no template", async () => {
		const emitter = new FakeStatusEmitter();
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { value: string }) => `ran:${input.value}`, {
				name: "unknown_tool",
				description: "Tool without template",
				schema: z.object({ value: z.string() }),
			}),
			{
				caller,
				store,
				broker,
				statusEmitter: emitter,
				locale: "en",
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			value: "test",
		});
		expect(result).toBe("ran:test");
		expect(emitter.calls).toHaveLength(0);
	});

	test("tool execution succeeds even when emitter throws", async () => {
		const emitter = new FakeStatusEmitter();
		emitter.shouldThrow = true;
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { file_path: string }) => `ran:${input.file_path}`, {
				name: "read_file",
				description: "Read a file",
				schema: z.object({ file_path: z.string() }),
			}),
			{
				caller,
				store,
				broker,
				statusEmitter: emitter,
				locale: "en",
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			file_path: "/src/index.ts",
		});
		expect(result).toBe("ran:/src/index.ts");
	});

	test("no status emitted when guard denies tool", async () => {
		const emitter = new FakeStatusEmitter();
		await store.upsertRule(caller.id, {
			priority: 100,
			toolName: "read_file",
			args: null,
			decision: "deny",
		});
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { file_path: string }) => `ran:${input.file_path}`, {
				name: "read_file",
				description: "Read a file",
				schema: z.object({ file_path: z.string() }),
			}),
			{
				caller,
				store,
				broker,
				statusEmitter: emitter,
				locale: "en",
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			file_path: "/src/index.ts",
		});
		expect(result).toMatch(/Permission denied by policy/);
		expect(emitter.calls).toHaveLength(0);
	});

	test("no status emitted when guard asks and user denies", async () => {
		const emitter = new FakeStatusEmitter();
		const broker = new FakeBroker("deny-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { file_path: string }) => `ran:${input.file_path}`, {
				name: "execute_workspace",
				description: "Execute tool",
				schema: z.object({ file_path: z.string() }),
			}),
			{
				caller,
				store,
				broker,
				statusEmitter: emitter,
				locale: "en",
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			file_path: "/src/index.ts",
		});
		expect(result).toMatch(/Permission denied by user/);
		expect(emitter.calls).toHaveLength(0);
	});

	test("no status emitted when no statusEmitter provided", async () => {
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { file_path: string }) => `ran:${input.file_path}`, {
				name: "read_file",
				description: "Read a file",
				schema: z.object({ file_path: z.string() }),
			}),
			{
				caller,
				store,
				broker,
				locale: "en",
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			file_path: "/src/index.ts",
		});
		expect(result).toBe("ran:/src/index.ts");
	});

	test("no status emitted when no locale provided", async () => {
		const emitter = new FakeStatusEmitter();
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(
			tool(async (input: { file_path: string }) => `ran:${input.file_path}`, {
				name: "read_file",
				description: "Read a file",
				schema: z.object({ file_path: z.string() }),
			}),
			{
				caller,
				store,
				broker,
				statusEmitter: emitter,
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			file_path: "/src/index.ts",
		});
		expect(result).toBe("ran:/src/index.ts");
		expect(emitter.calls).toHaveLength(0);
	});
});
