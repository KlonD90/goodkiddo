import { tool } from "langchain";
import { z } from "zod";
import type { WorkspaceBackend } from "../backends/types";
import type { ExecutionOrchestrator } from "../execution/orchestrator";
import {
	ExecuteScriptInputSchema,
	ExecuteWorkspaceInputSchema,
} from "../execution/schemas";

export function createExecuteScriptTool(orchestrator: ExecutionOrchestrator) {
	return tool(async (input) => orchestrator.executeScript(input), {
		name: "execute_script",
		description:
			"Execute a single script with optional support files. The orchestrator derives the internal manifest.",
		schema: ExecuteScriptInputSchema,
	});
}

export function createExecuteWorkspaceTool(
	orchestrator: ExecutionOrchestrator,
	workspace: WorkspaceBackend,
) {
	return tool(
		async (input) => orchestrator.executeWorkspace(input, workspace),
		{
			name: "execute_workspace",
			description:
				"Execute an entrypoint from the existing workspace. The orchestrator derives the internal manifest.",
			schema: ExecuteWorkspaceInputSchema,
		},
	);
}

export const ExecuteResultJsonSchema = z.object({
	exitCode: z.number(),
	stdout: z.string(),
	stderr: z.string(),
	outputArtifacts: z.array(
		z.object({
			path: z.string(),
			type: z.enum(["file", "directory"]),
			status: z.enum(["active", "quarantined"]),
			content: z.string().optional(),
		}),
	),
	durationMs: z.number(),
});
