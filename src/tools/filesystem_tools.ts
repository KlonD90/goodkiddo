import type { BackendProtocol } from "deepagents";
import { tool } from "langchain";
import { z } from "zod";

function toBackendPath(filePath: string): string {
	return filePath.startsWith("/") ? filePath : `/${filePath}`;
}

export function createWriteFileTool(backend: BackendProtocol) {
	return tool(
		async ({ path, content }: { path: string; content: string }) => {
			const result = await backend.write(toBackendPath(path), content);
			if ("error" in result && result.error) {
				throw new Error(result.error);
			}
			return `File written to ${result.path}`;
		},
		{
			name: "write_file",
			description: "Write a new file into the agent workspace.",
			schema: z.object({
				path: z.string().min(1).describe("Relative workspace path to create."),
				content: z.string().describe("File content."),
			}),
		},
	);
}

export function createReadFileTool(backend: BackendProtocol) {
	return tool(
		async ({ path }: { path: string }) => backend.read(toBackendPath(path)),
		{
			name: "read_file",
			description: "Read a file from the agent workspace.",
			schema: z.object({
				path: z.string().min(1).describe("Relative workspace path to read."),
			}),
		},
	);
}
