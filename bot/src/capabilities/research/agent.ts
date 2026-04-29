import { MemorySaver } from "@langchain/langgraph";
import { SearxngSearch } from "@langchain/community/tools/searxng_search";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createAgent, tool } from "langchain";
import { z } from "zod";
import type { WorkspaceBackend } from "../../backends/types";
import {
	createBrowserActionTool,
	createBrowserSnapshotTool,
	createSessionRegistry,
} from "../../tools/browser_tools";
import type { BrowserSessionManager } from "../../tools/browser_session_manager";
import {
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadFileTool,
} from "../../tools/filesystem_tools";
import { createTabularTools } from "../tabular/tools";
import type { TabularEngine } from "../tabular/engine";
import { ResearchNotes } from "./notes";
import { RESEARCH_SYSTEM_PROMPT } from "./prompts";

export interface BuildResearchAgentOptions {
	model: BaseChatModel;
	workspace: WorkspaceBackend;
	browserManager: BrowserSessionManager;
	callerId: string;
	runId: string;
	notes: ResearchNotes;
	tabularEngine?: TabularEngine;
}

function createRecordFindingTool(notes: ResearchNotes) {
	return tool(
		async ({
			source,
			summary,
		}: {
			source: string;
			summary: string;
		}) => {
			notes.add(source, summary);
			return `recorded finding from ${source}`;
		},
		{
			name: "record_finding",
			description:
				"Record a finding from a source. Call this for each useful source consulted during research.",
			schema: z.object({
				source: z
					.string()
					.describe("Source identifier (URL, file path, or other reference)"),
				summary: z
					.string()
					.describe(
						"Concise summary of what was learned from this source",
					),
			}),
		},
	);
}

export function buildResearchAgent(options: BuildResearchAgentOptions) {
	const { model, workspace, browserManager, runId, notes, tabularEngine } =
		options;

	const registry = createSessionRegistry(`research-${runId}`);

	const innerTools = [
		createBrowserSnapshotTool({ registry, manager: browserManager }),
		createBrowserActionTool({ registry, manager: browserManager }),
		new SearxngSearch({
			apiBase: process.env.SEARXNG_API_BASE ?? "http://127.0.0.1:8080",
			params: { format: "json", engines: "google" },
			headers: {},
		}),
		createLsTool(workspace),
		createReadFileTool(workspace),
		createGlobTool(workspace),
		createGrepTool(workspace),
		...(tabularEngine ? createTabularTools(tabularEngine, workspace) : []),
		createRecordFindingTool(notes),
	];

	return createAgent({
		model,
		tools: innerTools,
		systemPrompt: RESEARCH_SYSTEM_PROMPT,
		checkpointer: new MemorySaver(),
	});
}

export const FORBIDDEN_TOOL_NAMES = new Set([
	"write_file",
	"edit_file",
	"send_file",
	"grant_fs_access",
	"task_add",
	"task_complete",
	"task_dismiss",
	"task_list_active",
	"memory_write",
	"skill_write",
	"memory_append_log",
	"execute_workspace",
]);
