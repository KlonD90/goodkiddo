import { beforeEach, describe, expect, test } from "bun:test";
import { tool } from "langchain";
import { z } from "zod";
import {
	type ApprovalBroker,
	type ApprovalOutcome,
	type ApprovalRequest,
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

let store: PermissionsStore;

const sampleTool = () =>
	tool(async (input: { value: string }) => `ran:${input.value}`, {
		name: "sample",
		description: "Sample tool for tests.",
		schema: z.object({ value: z.string() }),
	});

beforeEach(() => {
	store = new PermissionsStore({ dbPath: ":memory:" });
	store.upsertUser({ entrypoint: "cli", externalId: "test" });
});

describe("wrapToolWithGuard", () => {
	test("allow rule passes through", async () => {
		store.upsertRule(caller.id, {
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
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({ value: "x" });
		expect(result).toBe("ran:x");
		expect(broker.lastRequest).toBeNull();
	});

	test("deny rule blocks without consulting broker", async () => {
		store.upsertRule(caller.id, {
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
		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({ value: "x" });
		expect(result).toMatch(/Permission denied by policy/);
		expect(broker.lastRequest).toBeNull();
	});

	test("default-ask consults broker; approve-once runs", async () => {
		const broker = new FakeBroker("approve-once");
		const wrapped = wrapToolWithGuard(sampleTool(), {
			caller,
			store,
			broker,
			audit: new NoopAuditLogger(),
		});
		const result = await wrapped.invoke({ value: "y" });
		expect(result).toBe("ran:y");
		expect(broker.lastRequest?.toolName).toBe("sample");
	});

	test("default-ask + deny-once returns denial", async () => {
		const broker = new FakeBroker("deny-once");
		const wrapped = wrapToolWithGuard(sampleTool(), {
			caller,
			store,
			broker,
			audit: new NoopAuditLogger(),
		});
		const result = await wrapped.invoke({ value: "z" });
		expect(result).toMatch(/Permission denied by user/);
	});
});
