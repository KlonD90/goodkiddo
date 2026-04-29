import { describe, expect, test } from "bun:test";
import { FakeToolCallingModel } from "langchain";
import { SqliteStateBackend } from "../../backends";
import { createDb, detectDialect } from "../../db";
import type { BrowserSessionManager } from "../../tools/browser_session_manager";
import {
	buildResearchAgent,
	FORBIDDEN_TOOL_NAMES,
} from "./agent";
import { ResearchNotes } from "./notes";

function createWorkspace(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

function stubBrowserManager(): BrowserSessionManager {
	return {
		canIssue: () => false,
		register: () => {},
		touch: () => {},
		release: () => {},
		isActive: () => false,
		reap: async () => {},
		count: () => 0,
	};
}

describe("buildResearchAgent", () => {
	test("inner toolset contains no forbidden tools", () => {
		const notes = new ResearchNotes();
		const model = new FakeToolCallingModel({ toolCalls: [] });
		const workspace = createWorkspace("toolset-check");
		const browserManager = stubBrowserManager();

		const agent = buildResearchAgent({
			model,
			workspace,
			browserManager,
			callerId: "test-caller",
			runId: "r-testrun1",
			notes,
		});

		const toolNames = (agent as any).options.tools.map((t: any) => t.name);
		for (const forbidden of FORBIDDEN_TOOL_NAMES) {
			expect(toolNames).not.toContain(forbidden);
		}
	});

	test("inner toolset includes expected read-only and research tools", () => {
		const notes = new ResearchNotes();
		const model = new FakeToolCallingModel({ toolCalls: [] });
		const workspace = createWorkspace("toolset-has");
		const browserManager = stubBrowserManager();

		const agent = buildResearchAgent({
			model,
			workspace,
			browserManager,
			callerId: "test-caller",
			runId: "r-testrun2",
			notes,
		});

		const toolNames = (agent as any).options.tools.map((t: any) => t.name);
		expect(toolNames).toContain("browser_snapshot");
		expect(toolNames).toContain("browser_action");
		expect(toolNames).toContain("ls");
		expect(toolNames).toContain("read_file");
		expect(toolNames).toContain("glob");
		expect(toolNames).toContain("grep");
		expect(toolNames).toContain("record_finding");
	});

	test("tabularEngine tools are added when provided", () => {
		const notes = new ResearchNotes();
		const model = new FakeToolCallingModel({ toolCalls: [] });
		const workspace = createWorkspace("toolset-tabular");
		const browserManager = stubBrowserManager();
		const tabularEngine = {
			describe: async () => ({ columns: [], rowCount: 0 }),
			head: async () => ({ columns: [], rows: [] }),
			sample: async () => ({ columns: [], rows: [] }),
			distinct: async () => ({ column: "x", values: [] }),
			filter: async () => ({ columns: [], rows: [] }),
			aggregate: async () => ({ columns: [], rows: [] }),
		} as unknown as import("../tabular/engine").TabularEngine;

		const agent = buildResearchAgent({
			model,
			workspace,
			browserManager,
			callerId: "test-caller",
			runId: "r-testrun3",
			notes,
			tabularEngine,
		});

		const toolNames = (agent as any).options.tools.map((t: any) => t.name);
		expect(toolNames).toContain("tabular_describe");
		expect(toolNames).toContain("tabular_filter");
		expect(toolNames).toContain("tabular_aggregate");
	});

	test("record_finding tool writes into notes and agent completes", async () => {
		const notes = new ResearchNotes();
		const model = new FakeToolCallingModel({
			toolCalls: [
				[
					{
						name: "record_finding",
						args: { source: "https://example.com", summary: "example info" },
						id: "tc-1",
						type: "tool_call",
					},
				],
				[],
			],
		});
		const workspace = createWorkspace("agent-run");
		const browserManager = stubBrowserManager();

		const agent = buildResearchAgent({
			model,
			workspace,
			browserManager,
			callerId: "test-caller",
			runId: "r-testrun4",
			notes,
		});

		const result = await agent.invoke(
			{ messages: [{ role: "user", content: "research question" }] },
			{ configurable: { thread_id: "test-thread-1" } },
		);

		expect(result).toBeDefined();
		const md = notes.serializeMarkdown();
		expect(md).toContain("https://example.com");
		expect(md).toContain("example info");
	});

	test("browser tools share the provided browserManager", async () => {
		const notes = new ResearchNotes();
		const model = new FakeToolCallingModel({ toolCalls: [] });
		const workspace = createWorkspace("shared-manager");
		let canIssueCallCount = 0;
		const browserManager: BrowserSessionManager = {
			canIssue: () => {
				canIssueCallCount++;
				return false;
			},
			register: () => {},
			touch: () => {},
			release: () => {},
			isActive: () => false,
			reap: async () => {},
			count: () => 0,
		};

		const agent = buildResearchAgent({
			model,
			workspace,
			browserManager,
			callerId: "test-caller",
			runId: "r-testrun5",
			notes,
		});

		const snapshotTool = (agent as any).options.tools.find(
			(t: any) => t.name === "browser_snapshot",
		);
		expect(snapshotTool).toBeDefined();

		await snapshotTool!.invoke({}).catch(() => {});
		expect(canIssueCallCount).toBeGreaterThan(0);
	});
});
