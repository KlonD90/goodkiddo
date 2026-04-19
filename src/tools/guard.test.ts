import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tool } from "langchain";
import { z } from "zod";
import type {
	ApprovalBroker,
	ApprovalOutcome,
	ApprovalRequest,
} from "../permissions/approval";
import { NoopAuditLogger } from "../permissions/audit";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import { wrapToolWithGuard } from "./guard";

class FakeBroker implements ApprovalBroker {
	public lastRequest: ApprovalRequest | null = null;
	constructor(private readonly outcome: ApprovalOutcome) {}
	async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
		this.lastRequest = request;
		return this.outcome;
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
			audit: new NoopAuditLogger(),
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
			audit: new NoopAuditLogger(),
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
			audit: new NoopAuditLogger(),
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
				audit: new NoopAuditLogger(),
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
				audit: new NoopAuditLogger(),
			},
		);
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			value: "z",
		});
		expect(result).toMatch(/Permission denied by user/);
	});
});
