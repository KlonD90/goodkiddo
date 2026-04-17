import type { WorkspaceBackend } from "../backends/types";
import type { ExecutionPolicy } from "../execution/manifest";
import { ExecutionOrchestrator } from "../execution/orchestrator";
import type { CreateSandboxBackendOptions } from "../sandbox/factory";
import { createSandboxBackend } from "../sandbox/factory";
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

export interface CreateExecutionToolsetOptions {
	workspace: WorkspaceBackend;
	backend?: CreateSandboxBackendOptions;
	policy?: ExecutionPolicy;
	guard?: GuardContext;
	enableExecute?: boolean;
	callerId?: string;
}

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
		...(executeTool ? [executeTool] : []),
	];

	if (!options.guard) return tools;
	const guard = options.guard;
	return tools.map((original) => wrapToolWithGuard(original, guard));
}
