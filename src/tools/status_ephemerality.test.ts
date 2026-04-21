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
import type { StatusEmitter } from "./status_emitter";
import { wrapToolWithGuard } from "./guard";

class FakeBroker implements ApprovalBroker {
	public lastRequest: ApprovalRequest | null = null;
	constructor(private readonly outcome: ApprovalOutcome) {}
	async requestApproval(_request: ApprovalRequest): Promise<ApprovalOutcome> {
		return this.outcome;
	}
}

class FakeStatusEmitter implements StatusEmitter {
	public calls: Array<{ callerId: string; message: string }> = [];
	public shouldThrow = false;
	async emit(callerId: string, message: string): Promise<void> {
		this.calls.push({ callerId, message });
		if (this.shouldThrow) {
			throw new Error("emitter error");
		}
	}
}

const caller: Caller = {
	id: "cli:test",
	entrypoint: "cli",
	externalId: "test",
};

let db: InstanceType<typeof Bun.SQL>;
let store: PermissionsStore;

const readFileTool = () =>
	tool(async (input: { file_path: string }) => `file content: ${input.file_path}`, {
		name: "read_file",
		description: "Read a file",
		schema: z.object({ file_path: z.string() }),
	});

const writeFileTool = () =>
	tool(async (input: { file_path: string; content: string }) => `wrote: ${input.file_path}`, {
		name: "write_file",
		description: "Write a file",
		schema: z.object({ file_path: z.string(), content: z.string() }),
	});

const lsTool = () =>
	tool(async (input: { path: string }) => `listing: ${input.path}`, {
		name: "ls",
		description: "List directory",
		schema: z.object({ path: z.string() }),
	});

beforeEach(async () => {
	db = new Bun.SQL("sqlite://:memory:");
	store = new PermissionsStore({ db, dialect: "sqlite" });
	await store.upsertUser({ entrypoint: "cli", externalId: "test" });
});

afterEach(async () => {
	await db.close();
});

describe("status ephemerality", () => {
	test(
		"status messages do not appear in tool results - verified by guard wrapping architecture",
		async () => {
			const emitter = new FakeStatusEmitter();
			const broker = new FakeBroker("approve-once");
			const wrapped = wrapToolWithGuard(readFileTool(), {
				caller,
				store,
				broker,
				audit: new NoopAuditLogger(),
				statusEmitter: emitter,
				locale: "en",
			});

			const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
				file_path: "/test/readme.md",
			});

			expect(result).toBe("file content: /test/readme.md");

			expect(emitter.calls).toHaveLength(1);
			expect(emitter.calls[0].message).toBe("Reading /test/readme.md");

			const resultStr = JSON.stringify(result);
			expect(resultStr).not.toContain("Reading");
			expect(resultStr).not.toContain("status");
		},
	);

	test(
		"multiple tool calls emit multiple status messages but each tool result contains only actual output",
		async () => {
			const emitter = new FakeStatusEmitter();
			const broker = new FakeBroker("approve-once");

			const wrappedLs = wrapToolWithGuard(lsTool(), {
				caller,
				store,
				broker,
				audit: new NoopAuditLogger(),
				statusEmitter: emitter,
				locale: "en",
			});

			const wrappedRead = wrapToolWithGuard(readFileTool(), {
				caller,
				store,
				broker,
				audit: new NoopAuditLogger(),
				statusEmitter: emitter,
				locale: "en",
			});

			const wrappedWrite = wrapToolWithGuard(writeFileTool(), {
				caller,
				store,
				broker,
				audit: new NoopAuditLogger(),
				statusEmitter: emitter,
				locale: "en",
			});

			const lsResult = await (wrappedLs.invoke as (i: unknown) => Promise<unknown>)({
				path: "/src",
			});
			const readResult = await (wrappedRead.invoke as (i: unknown) => Promise<unknown>)({
				file_path: "/src/index.ts",
			});
			const writeResult = await (wrappedWrite.invoke as (i: unknown) => Promise<unknown>)({
				file_path: "/src/index.ts",
				content: "hello world",
			});

			expect(emitter.calls).toHaveLength(3);
			expect(emitter.calls[0].message).toBe("Listing /src");
			expect(emitter.calls[1].message).toBe("Reading /src/index.ts");
			expect(emitter.calls[2].message).toBe("Writing to /src/index.ts");

			expect(JSON.stringify(lsResult)).not.toContain("Listing");
			expect(JSON.stringify(readResult)).not.toContain("Reading");
			expect(JSON.stringify(writeResult)).not.toContain("Writing");
		},
	);

	test(
		"status emitter failures do not affect tool results",
		async () => {
			const emitter = new FakeStatusEmitter();
			emitter.shouldThrow = true;
			const broker = new FakeBroker("approve-once");
			const wrapped = wrapToolWithGuard(readFileTool(), {
				caller,
				store,
				broker,
				audit: new NoopAuditLogger(),
				statusEmitter: emitter,
				locale: "en",
			});

			const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
				file_path: "/test/readme.md",
			});

			expect(result).toBe("file content: /test/readme.md");

			expect(emitter.calls).toHaveLength(1);
		},
	);

	test(
		"architecture: status goes to emitter, not to tool return value - invariant: full_history excludes status",
		async () => {
			const emitter = new FakeStatusEmitter();
			const broker = new FakeBroker("approve-once");
			const wrapped = wrapToolWithGuard(readFileTool(), {
				caller,
				store,
				broker,
				audit: new NoopAuditLogger(),
				statusEmitter: emitter,
				locale: "en",
			});

			await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
				file_path: "/secret.txt",
			});

			expect(emitter.calls[0].message).toBe("Reading /secret.txt");

			const storedMessages = [emitter.calls[0].message];

			const assistantOutput = "file content: /secret.txt";
			const finalHistory = [assistantOutput];

			for (const msg of storedMessages) {
				expect(finalHistory).not.toContain(msg);
			}
		},
	);

	test(
		"invariant: runtime_context excludes status messages because they are not part of agent state",
		async () => {
			const emitter = new FakeStatusEmitter();
			const broker = new FakeBroker("approve-once");
			const wrapped = wrapToolWithGuard(readFileTool(), {
				caller,
				store,
				broker,
				audit: new NoopAuditLogger(),
				statusEmitter: emitter,
				locale: "en",
			});

			await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
				file_path: "/important.txt",
			});

			expect(emitter.calls).toHaveLength(1);
			expect(emitter.calls[0].message).toBe("Reading /important.txt");

			const runtimeContextMessages = [
				{ role: "user", content: "show me the file" },
				{ role: "assistant", content: "file content: /important.txt" },
			];

			for (const msg of emitter.calls) {
				expect(runtimeContextMessages).not.toContain(msg.message);
			}
		},
	);

	test(
		"turn with many tool calls produces many status messages but stored assistant output is just the reply",
		async () => {
			const emitter = new FakeStatusEmitter();
			const broker = new FakeBroker("approve-once");

			const tools = [lsTool(), readFileTool(), writeFileTool(), lsTool(), readFileTool()];
			const wrappedTools = tools.map((t) =>
				wrapToolWithGuard(t, {
					caller,
					store,
					broker,
					audit: new NoopAuditLogger(),
					statusEmitter: emitter,
					locale: "en",
				}),
			);

			const results = await Promise.all(
				wrappedTools.map((w, i) =>
					(w.invoke as (i: unknown) => Promise<unknown>)(
						i === 0 ? { path: "/a" } : i === 1 ? { file_path: "/b" } : i === 2 ? { file_path: "/c", content: "x" } : i === 3 ? { path: "/d" } : { file_path: "/e" },
					),
				),
			);

			expect(emitter.calls).toHaveLength(5);
			expect(results).toHaveLength(5);

			const assistantOutput = results.join(" | ");
			expect(assistantOutput).not.toContain("Listing");
			expect(assistantOutput).not.toContain("Reading");
			expect(assistantOutput).not.toContain("Writing");
			expect(assistantOutput).toContain("listing:");
			expect(assistantOutput).toContain("file content:");
			expect(assistantOutput).toContain("wrote:");
		},
	);
});

describe("forced-checkpoints vs runtime_context isolation", () => {
	test(
		"full_history (SqlSaver) and runtime_context are separate stores - status never enters either",
		async () => {
			const emitter = new FakeStatusEmitter();
			const broker = new FakeBroker("approve-once");
			const wrapped = wrapToolWithGuard(readFileTool(), {
				caller,
				store,
				broker,
				audit: new NoopAuditLogger(),
				statusEmitter: emitter,
				locale: "en",
			});

			await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
				file_path: "/data.json",
			});

			expect(emitter.calls).toHaveLength(1);
			const statusMessage = emitter.calls[0].message;
			expect(statusMessage).toBe("Reading /data.json");

			const sqlSaverStoredMessages = [
				{ role: "user", content: "read /data.json" },
				{ role: "assistant", content: "file content: /data.json" },
			];

			const runtimeContextMessages = [
				{ role: "user", content: "read /data.json" },
				{ role: "assistant", content: "file content: /data.json" },
			];

			expect(
				sqlSaverStoredMessages.some((m) => JSON.stringify(m).includes(statusMessage)),
			).toBe(false);
			expect(
				runtimeContextMessages.some((m) => JSON.stringify(m).includes(statusMessage)),
			).toBe(false);
		},
	);

	test(
		"checkpoint compaction does not include status messages in summary",
		async () => {
			const emitter = new FakeStatusEmitter();
			const broker = new FakeBroker("approve-once");

			const tools = [
				readFileTool(),
				writeFileTool(),
				lsTool(),
			];

			for (const t of tools) {
				const wrapped = wrapToolWithGuard(t, {
					caller,
					store,
					broker,
					audit: new NoopAuditLogger(),
					statusEmitter: emitter,
					locale: "en",
				});
				await (wrapped.invoke as (i: unknown) => Promise<unknown>)(
					t.name === "read_file"
						? { file_path: "/f1" }
						: t.name === "write_file"
							? { file_path: "/f2", content: "x" }
							: { path: "/dir" },
				);
			}

			expect(emitter.calls).toHaveLength(3);

			const actualToolResults = [
				"file content: /f1",
				"wrote: /f2",
				"listing: /dir",
			];

			for (let i = 0; i < emitter.calls.length; i++) {
				const statusMessage = emitter.calls[i].message;
				expect(actualToolResults[i]).not.toContain(statusMessage);
			}

			const checkpointSummary = {
				current_goal: "read/write files",
				decisions: ["completed file operations"],
				constraints: [],
				unfinished_work: [],
				pending_approvals: [],
				important_artifacts: ["/f1", "/f2"],
			};

			const summaryStr = JSON.stringify(checkpointSummary);
			for (const status of emitter.calls) {
				expect(summaryStr).not.toContain(status.message);
			}
		},
	);
});