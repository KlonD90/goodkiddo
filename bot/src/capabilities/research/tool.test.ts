import { GraphRecursionError } from "@langchain/langgraph";
import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { WorkspaceBackend } from "../../backends/types";
import type { BrowserSessionManager } from "../../tools/browser_session_manager";
import { createResearchTool } from "./tool";

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

type WriteRecord = [string, string];

function mockWorkspace(): {
	writes: WriteRecord[];
	ws: WorkspaceBackend;
} {
	const writes: WriteRecord[] = [];
	return {
		writes,
		ws: {
			write: async (path: string, content: string) => {
				writes.push([path, content]);
				return { ok: true, filesUpdated: [], filesCreated: [path] };
			},
		} as unknown as WorkspaceBackend,
	};
}

function aiMessage(content: string) {
	return { getType: () => "ai", content };
}

function fakeAgentReturning(msgs: unknown[]) {
	return {
		invoke: async (_input: unknown, _config: unknown) => ({ messages: msgs }),
	};
}

function fakeAgentRecordingConfig(msgs: unknown[], recorded: unknown[]) {
	return {
		invoke: async (_input: unknown, config: unknown) => {
			recorded.push(config);
			return { messages: msgs };
		},
	};
}

function fakeAgentThrowingRecursion() {
	return {
		invoke: async () => {
			throw new GraphRecursionError("Recursion limit reached");
		},
	};
}

function noopModel(): BaseChatModel {
	return {
		invoke: async () => ({ content: "" }),
	} as unknown as BaseChatModel;
}

describe("createResearchTool", () => {
	test("happy path returns the final AI message", async () => {
		const { ws } = mockWorkspace();
		const t = createResearchTool({
			model: noopModel(),
			workspace: ws,
			browserManager: stubBrowserManager(),
			_buildAgent: () =>
				fakeAgentReturning([aiMessage("Research synthesis result.")]),
		});

		const result = await t.invoke({ question: "What is the best headphone?" });
		expect(result).toContain("Research synthesis result.");
	});

	test("notes file is written to research/<runId>.md after successful run", async () => {
		const { ws, writes } = mockWorkspace();
		const t = createResearchTool({
			model: noopModel(),
			workspace: ws,
			browserManager: stubBrowserManager(),
			_buildAgent: () => fakeAgentReturning([aiMessage("Summary.")]),
		});

		await t.invoke({ question: "Test question" });
		expect(writes.length).toBeGreaterThan(0);
		const [notesPath, notesContent] = writes[0];
		expect(notesPath).toMatch(/^research\/r-[a-z0-9]{8}\.md$/);
		expect(notesContent).toContain("# Research Notes");
	});

	test("recursion limit is propagated from depth parameter", async () => {
		const { ws } = mockWorkspace();
		const capturedConfigs: unknown[] = [];
		const t = createResearchTool({
			model: noopModel(),
			workspace: ws,
			browserManager: stubBrowserManager(),
			_buildAgent: () =>
				fakeAgentRecordingConfig([aiMessage("done")], capturedConfigs),
		});

		await t.invoke({ question: "q", depth: "quick" });
		await t.invoke({ question: "q", depth: "deep" });

		const [quickConfig, deepConfig] = capturedConfigs as {
			recursionLimit: number;
		}[];
		expect(quickConfig.recursionLimit).toBe(15);
		expect(deepConfig.recursionLimit).toBe(80);
	});

	test("standard depth uses 40 as recursion limit", async () => {
		const { ws } = mockWorkspace();
		const capturedConfigs: unknown[] = [];
		const t = createResearchTool({
			model: noopModel(),
			workspace: ws,
			browserManager: stubBrowserManager(),
			_buildAgent: () =>
				fakeAgentRecordingConfig([aiMessage("done")], capturedConfigs),
		});

		await t.invoke({ question: "q" });
		await t.invoke({ question: "q", depth: "standard" });

		const [defaultConfig, standardConfig] = capturedConfigs as {
			recursionLimit: number;
		}[];
		expect(defaultConfig.recursionLimit).toBe(40);
		expect(standardConfig.recursionLimit).toBe(40);
	});

	test("oversized output is trimmed with notes-path pointer", async () => {
		const { ws } = mockWorkspace();
		const bigSummary = "A".repeat(10000);
		const t = createResearchTool({
			model: noopModel(),
			workspace: ws,
			browserManager: stubBrowserManager(),
			_buildAgent: () => fakeAgentReturning([aiMessage(bigSummary)]),
		});

		const result = (await t.invoke({
			question: "big question",
		})) as string;
		expect(result.length).toBeLessThan(bigSummary.length);
		expect(result).toContain("research/");
		expect(result).toContain(".md");
	});

	test("recursion error path returns polite string and does not throw", async () => {
		const { ws } = mockWorkspace();
		const t = createResearchTool({
			model: noopModel(),
			workspace: ws,
			browserManager: stubBrowserManager(),
			_buildAgent: () => fakeAgentThrowingRecursion(),
		});

		const result = (await t.invoke({
			question: "complex question",
		})) as string;
		expect(typeof result).toBe("string");
		expect(result).toContain("recursion limit");
		expect(result).toContain("research/");
	});

	test("recursion error writes partial notes before returning", async () => {
		const { ws, writes } = mockWorkspace();
		const t = createResearchTool({
			model: noopModel(),
			workspace: ws,
			browserManager: stubBrowserManager(),
			_buildAgent: () => fakeAgentThrowingRecursion(),
		});

		await t.invoke({ question: "question" });
		expect(writes.length).toBeGreaterThan(0);
		const [notesPath] = writes[0];
		expect(notesPath).toMatch(/^research\/r-[a-z0-9]{8}\.md$/);
	});

	test("brief includes question, hints, and input paths", async () => {
		const { ws } = mockWorkspace();
		const capturedInputs: { messages: { content: string }[] }[] = [];
		const t = createResearchTool({
			model: noopModel(),
			workspace: ws,
			browserManager: stubBrowserManager(),
			_buildAgent: () => ({
				invoke: async (
					input: { messages: { content: string }[] },
					_config: unknown,
				) => {
					capturedInputs.push(input);
					return { messages: [aiMessage("done")] };
				},
			}),
		});

		await t.invoke({
			question: "What is X?",
			hints: ["Focus on performance"],
			inputs: ["/workspace/data.csv"],
		});

		expect(capturedInputs.length).toBe(1);
		const brief = capturedInputs[0].messages[0].content;
		expect(brief).toContain("What is X?");
		expect(brief).toContain("Focus on performance");
		expect(brief).toContain("/workspace/data.csv");
	});
});
