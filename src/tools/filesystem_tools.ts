import type { BackendProtocol } from "deepagents";
import { context, tool } from "langchain";
import { z } from "zod";
import {
	formatReadResponse,
	MAX_LINE_LENGTH,
	truncateIfTooLong,
} from "../utils/filesystem.js";

const DEFAULT_READ_LINE_LIMIT = 100;

function toBackendPath(filePath: string): string {
	return filePath.startsWith("/") ? filePath : `/${filePath}`;
}

function resolvePathInput(input: {
	file_path?: string;
	path?: string;
}): string {
	const filePath = input.file_path ?? input.path;
	if (!filePath) {
		throw new Error("file_path is required");
	}
	return toBackendPath(filePath);
}

type DownloadableBackend = BackendProtocol & {
	downloadFiles(
		paths: string[],
	): Promise<
		Array<{ path: string; content: Uint8Array | null; error: string | null }>
	>;
};

function hasDownloadFiles(
	backend: BackendProtocol,
): backend is DownloadableBackend {
	return (
		"downloadFiles" in backend && typeof backend.downloadFiles === "function"
	);
}

function detectMimeType(filePath: string): string | null {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".bmp")) return "image/bmp";
	if (lower.endsWith(".svg")) return "image/svg+xml";
	if (lower.endsWith(".pdf")) return "application/pdf";
	return null;
}

function isMultimodalMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

// respect https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/middleware/fs.ts for inspiration

const LS_TOOL_PROMPT = context`Lists all files in a directory.

This is useful for exploring the filesystem and finding the right file to read or edit.
You should almost ALWAYS use this tool before using the read_file or edit_file tools.`;

const GLOB_TOOL_PROMPT = context`Find files matching a glob pattern.

Supports standard glob patterns:
- \`*\` (any characters)
- \`**\` (any directories)
- \`?\` (single character)

Returns a list of absolute file paths that match the pattern.

Examples:
- \`**/*.py\` - Find all Python files
- \`*.txt\` - Find all text files in root
- \`/subdir/**/*.md\` - Find all markdown files under /subdir`;

const GREP_TOOL_PROMPT = context`Search for a text pattern across files.

Searches using a regex pattern across files and returns matching lines grouped by file.
Examples:
- Search all files: \`grep(pattern="TODO")\`
- Search Python files only: \`grep(pattern="import", glob="*.py")\`
- Search for code with special chars: \`grep(pattern="def __init__(self):")\``;

const FILE_WRITE_PROMPT = context`Writes to a new file in the filesystem.

  Usage:
  - The write_file tool will create a new file.
  - Prefer to edit existing files (with the edit_file tool) over creating new ones when possible.
`;

const FILE_EDIT_PROMPT = context`Performs exact string replacements in files.

Usage:
- You must read the file before editing. This tool will error if you attempt an edit without reading the file first.
- When editing, preserve the exact indentation (tabs/spaces) from the read output. Never include line number prefixes in old_string or new_string.
- ALWAYS prefer editing existing files over creating new ones.
- Only use emojis if the user explicitly requests it.`;

const FILE_READ_PROMPT = context`
  Reads a file from the filesystem.

    Assume this tool is able to read all files. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

    Usage:
    - By default, it reads up to 100 lines starting from the beginning of the file
    - **IMPORTANT for large files and codebase exploration**: Use pagination with offset and limit parameters to avoid context overflow
      - First scan: read_file(path, limit=100) to see file structure
      - Read more sections: read_file(path, offset=100, limit=200) for next 200 lines
      - Only omit limit (read full file) when necessary for editing
    - Specify offset and limit: read_file(path, offset=0, limit=100) reads first 100 lines
    - Results are returned using cat -n format, with line numbers starting at 1
  - Lines longer than ${MAX_LINE_LENGTH} characters will be split into multiple lines with continuation markers (e.g., 5.1, 5.2, etc.). When you specify a limit, these continuation lines count towards the limit.
    - You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
    - If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
    - You should ALWAYS make sure a file has been read before editing it.`;

export function createLsTool(backend: BackendProtocol) {
	return tool(
		async ({ path = "/" }: { path?: string }) => {
			const infos = await backend.lsInfo(toBackendPath(path));

			if (infos.length === 0) {
				return `No files found in ${toBackendPath(path)}`;
			}

			const result = truncateIfTooLong(
				infos.map((info) =>
					info.is_dir
						? `${info.path} (directory)`
						: `${info.path}${info.size ? ` (${info.size} bytes)` : ""}`,
				),
			);

			return Array.isArray(result) ? result.join("\n") : result;
		},
		{
			name: "ls",
			description: LS_TOOL_PROMPT,
			schema: z.object({
				path: z
					.string()
					.optional()
					.default("/")
					.describe("Directory path to list (default: /)."),
			}),
		},
	);
}

export function createReadFileTool(backend: BackendProtocol) {
	return tool(
		async ({
			file_path,
			offset,
			limit,
		}: {
			file_path?: string;
			offset?: number | string;
			limit?: number | string;
		}) => {
			const resolvedPath = resolvePathInput({ file_path });
			const resolvedOffset = offset !== undefined ? Number(offset) : 0;
			const resolvedLimit =
				limit !== undefined ? Number(limit) : DEFAULT_READ_LINE_LIMIT;
			const mimeType = detectMimeType(resolvedPath);

			if (
				mimeType !== null &&
				isMultimodalMimeType(mimeType) &&
				hasDownloadFiles(backend)
			) {
				const results = await backend.downloadFiles([resolvedPath]);
				const response = results[0];

				if (!response || response.error) {
					const errorMessage =
						response?.error === "file_not_found"
							? `File '${resolvedPath}' not found`
							: (response?.error ?? `Failed to download '${resolvedPath}'`);
					return `Error: ${errorMessage}`;
				}

				if (response.content) {
					return [
						{
							type: "text",
							text: `Attached file '${resolvedPath}' (${mimeType}) for multimodal inspection.`,
						},
						{
							type: mimeType.startsWith("image/") ? "image" : "file",
							mimeType,
							data: response.content,
						},
					];
				}
			}

			try {
				const fileData = await backend.readRaw(resolvedPath);
				let result = formatReadResponse(
					fileData,
					resolvedOffset,
					resolvedLimit,
				);
				const lines = result.split("\n");
				if (lines.length > resolvedLimit) {
					result = lines.slice(0, resolvedLimit).join("\n");
				}
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
		{
			name: "read_file",
			description: FILE_READ_PROMPT,
			schema: z.object({
				file_path: z
					.string()
					.min(1)
					.describe("Absolute path to the file to read"),
				offset: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.default(0)
					.describe("Line offset to start reading from (0-indexed)"),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.default(DEFAULT_READ_LINE_LIMIT)
					.describe("Maximum number of lines to read"),
			}),
		},
	);
}

export function createWriteFileTool(backend: BackendProtocol) {
	return tool(
		async ({ file_path, content }: { file_path?: string; content: string }) => {
			const result = await backend.write(
				resolvePathInput({ file_path }),
				content,
			);
			if ("error" in result && result.error) {
				return result.error;
			}
			return `Successfully wrote to '${resolvePathInput({ file_path })}'`;
		},
		{
			name: "write_file",
			description: FILE_WRITE_PROMPT,
			schema: z.object({
				file_path: z
					.string()
					.min(1)
					.describe("Absolute path to the file to write"),
				content: z
					.string()
					.default("")
					.describe("Content to write to the file"),
			}),
		},
	);
}

export function createEditFileTool(backend: BackendProtocol) {
	return tool(
		async ({
			file_path,
			old_string,
			new_string,
			replace_all,
		}: {
			file_path?: string;
			old_string?: string;
			new_string?: string;
			replace_all?: boolean;
		}) => {
			if (old_string === undefined) {
				throw new Error("old_string is required");
			}
			if (new_string === undefined) {
				throw new Error("new_string is required");
			}

			const result = await backend.edit(
				resolvePathInput({ file_path }),
				old_string,
				new_string,
				replace_all,
			);
			if ("error" in result && result.error) {
				return result.error;
			}
			return `Successfully replaced ${result.occurrences} occurrence(s) in '${resolvePathInput({ file_path })}'`;
		},
		{
			name: "edit_file",
			description: FILE_EDIT_PROMPT,
			schema: z.object({
				file_path: z
					.string()
					.min(1)
					.describe("Absolute path to the file to edit"),
				old_string: z
					.string()
					.describe("String to be replaced (must match exactly)"),
				new_string: z.string().describe("String to replace with"),
				replace_all: z
					.boolean()
					.optional()
					.default(false)
					.describe("Whether to replace all occurrences"),
			}),
		},
	);
}

export function createGlobTool(backend: BackendProtocol) {
	return tool(
		async ({ pattern, path = "/" }: { pattern: string; path?: string }) => {
			const infos = await backend.globInfo(pattern, toBackendPath(path));

			if (infos.length === 0) {
				return `No files found matching pattern '${pattern}'`;
			}

			const result = truncateIfTooLong(infos.map((info) => info.path));
			return Array.isArray(result) ? result.join("\n") : result;
		},
		{
			name: "glob",
			description: GLOB_TOOL_PROMPT,
			schema: z.object({
				pattern: z.string().min(1).describe("Glob pattern to match."),
				path: z
					.string()
					.optional()
					.default("/")
					.describe("Base path to search from (default: /)"),
			}),
		},
	);
}

export function createGrepTool(backend: BackendProtocol) {
	return tool(
		async ({
			pattern,
			path = "/",
			glob,
		}: {
			pattern: string;
			path?: string;
			glob?: string;
		}) => {
			const matches = await backend.grepRaw(
				pattern,
				toBackendPath(path),
				glob ?? null,
			);

			if (typeof matches === "string") {
				return matches;
			}

			if (matches.length === 0) {
				return `No matches found for pattern '${pattern}'`;
			}

			const lines: string[] = [];
			let currentFile: string | null = null;

			for (const match of matches) {
				if (match.path !== currentFile) {
					currentFile = match.path;
					lines.push(`\n${currentFile}:`);
				}
				lines.push(`  ${match.line}: ${match.text}`);
			}

			const result = truncateIfTooLong(lines);
			return Array.isArray(result) ? result.join("\n") : result;
		},
		{
			name: "grep",
			description: GREP_TOOL_PROMPT,
			schema: z.object({
				pattern: z.string().min(1).describe("Regex pattern to search for"),
				path: z
					.string()
					.optional()
					.default("/")
					.describe("Base path to search from (default: /)"),
				glob: z
					.string()
					.optional()
					.nullable()
					.describe("Optional glob pattern to filter files (e.g., '*.py')"),
			}),
		},
	);
}
