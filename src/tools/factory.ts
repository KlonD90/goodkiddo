import type { WorkspaceBackend } from "../backends/types";
import type { ExecutionPolicy } from "../execution/manifest";
import { ExecutionOrchestrator } from "../execution/orchestrator";
import type { CreateSandboxBackendOptions } from "../sandbox/factory";
import { createSandboxBackend } from "../sandbox/factory";
import { createExecuteWorkspaceTool } from "./execute_tools";
import {
	createEditFileTool,
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadFileTool,
	createWriteFileTool,
} from "./filesystem_tools";

export interface CreateExecutionToolsetOptions {
	workspace: WorkspaceBackend;
	backend?: CreateSandboxBackendOptions;
	policy?: ExecutionPolicy;
}

export async function createExecutionToolset(
	options: CreateExecutionToolsetOptions,
) {
	const sandboxBackend = await createSandboxBackend(options.backend);
	const orchestrator = new ExecutionOrchestrator({
		backend: sandboxBackend,
		policy: options.policy,
	});

	return [
		createLsTool(options.workspace),
		createReadFileTool(options.workspace),
		createWriteFileTool(options.workspace),
		createEditFileTool(options.workspace),
		createGlobTool(options.workspace),
		createGrepTool(options.workspace),
		createExecuteWorkspaceTool(orchestrator, options.workspace),
	];
}
