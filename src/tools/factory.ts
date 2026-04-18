import { SearxngSearch } from "@langchain/community/tools/searxng_search";
import type { WorkspaceBackend } from "../backends/types";
import type { OutboundChannel } from "../channels/outbound";
import type { ExecutionPolicy } from "../execution/manifest";
import { ExecutionOrchestrator } from "../execution/orchestrator";
import type { CreateSandboxBackendOptions } from "../sandbox/factory";
import { createSandboxBackend } from "../sandbox/factory";
import type { AccessStore } from "../server/access_store";
import {
	createBrowserActionTool,
	createBrowserSnapshotTool,
	createSessionRegistry,
} from "./browser_tools";
import { createExecuteWorkspaceTool } from "./execute_tools";
import {
	createEditFileTool,
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadFileTool,
	createWriteFileTool,
} from "./filesystem_tools";
import { type GuardContext, wrapToolWithGuard } from "./guard";
import {
	createMemoryAppendLogTool,
	createMemoryWriteTool,
	createSkillWriteTool,
} from "./memory_tools";
import { createSendFileTool } from "./send_file_tool";
import { createGrantFsAccessTool } from "./share_tools";

export interface WebShareOptions {
	access: AccessStore;
	publicBaseUrl: string;
}

export interface CreateExecutionToolsetOptions {
	workspace: WorkspaceBackend;
	backend?: CreateSandboxBackendOptions;
	policy?: ExecutionPolicy;
	guard?: GuardContext;
	enableExecute?: boolean;
	callerId?: string;
	outbound?: OutboundChannel;
	webShare?: WebShareOptions;
}

const UNGUARDED_TOOL_NAMES = new Set<string>(["send_file", "grant_fs_access"]);

export async function createExecutionToolset(
	options: CreateExecutionToolsetOptions,
) {
	const enableExecute = options.enableExecute ?? true;

	let executeTool: ReturnType<typeof createExecuteWorkspaceTool> | null = null;
	if (enableExecute) {
		const sandboxBackend = await createSandboxBackend(options.backend);
		const orchestrator = new ExecutionOrchestrator({
			backend: sandboxBackend,
			policy: options.policy,
		});
		executeTool = createExecuteWorkspaceTool(orchestrator, options.workspace);
	}

	const browserRegistry = createSessionRegistry(options.callerId ?? "shared");

	const sendFileTool =
		options.outbound && options.callerId
			? createSendFileTool({
					workspace: options.workspace,
					outbound: options.outbound,
					callerId: options.callerId,
				})
			: null;

	const shareTool =
		options.webShare && options.callerId
			? createGrantFsAccessTool({
					access: options.webShare.access,
					workspace: options.workspace,
					callerId: options.callerId,
					publicBaseUrl: options.webShare.publicBaseUrl,
				})
			: null;

	const tools = [
		createLsTool(options.workspace),
		createReadFileTool(options.workspace),
		createWriteFileTool(options.workspace),
		createEditFileTool(options.workspace),
		createGlobTool(options.workspace),
		createGrepTool(options.workspace),
		createMemoryWriteTool(options.workspace),
		createSkillWriteTool(options.workspace),
		createMemoryAppendLogTool(options.workspace),
		createBrowserSnapshotTool({ registry: browserRegistry }),
		createBrowserActionTool({ registry: browserRegistry }),
		new SearxngSearch({
			params: {
				format: "json", // Do not change this, format other than "json" is will throw error
				engines: "google",
			},
			// Custom Headers to support rapidAPI authentication Or any instance that requires custom headers
			headers: {},
		}),
		...(executeTool ? [executeTool] : []),
		...(sendFileTool ? [sendFileTool] : []),
		...(shareTool ? [shareTool] : []),
	];

	if (!options.guard) return tools;
	const guard = options.guard;
	return tools.map((original) => {
		if (UNGUARDED_TOOL_NAMES.has(original.name)) return original;
		return wrapToolWithGuard(original, guard);
	});
}
