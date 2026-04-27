import type { FileData } from "deepagents";

export const EMPTY_CONTENT_WARNING =
	"System reminder: File exists but has empty contents";

const MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".txt": "text/plain",
	".log": "text/plain",
	".json": "application/json",
	".jsonc": "application/json",
	".xml": "application/xml",
	".html": "text/html",
	".htm": "text/html",
	".css": "text/css",
	".scss": "text/x-scss",
	".sass": "text/x-sass",
	".less": "text/x-less",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".cjs": "text/javascript",
	".ts": "text/typescript",
	".tsx": "text/typescript",
	".jsx": "text/jsx",
	".yaml": "text/yaml",
	".yml": "text/yaml",
	".toml": "text/toml",
	".csv": "text/csv",
	".tsv": "text/tab-separated-values",
	".sh": "text/x-shellscript",
	".bash": "text/x-shellscript",
	".zsh": "text/x-shellscript",
	".fish": "text/x-shellscript",
	".py": "text/x-python",
	".rb": "text/x-ruby",
	".go": "text/x-go",
	".rs": "text/x-rust",
	".java": "text/x-java",
	".kt": "text/x-kotlin",
	".swift": "text/x-swift",
	".c": "text/x-c",
	".h": "text/x-c",
	".cpp": "text/x-c++",
	".cc": "text/x-c++",
	".hpp": "text/x-c++",
	".cs": "text/x-csharp",
	".php": "application/x-php",
	".lua": "text/x-lua",
	".sql": "text/x-sql",
	".dockerfile": "text/x-dockerfile",
	".env": "text/plain",
	".ini": "text/x-ini",
	".conf": "text/plain",
	".gitignore": "text/plain",
	".zip": "application/zip",
	".tar": "application/x-tar",
	".gz": "application/gzip",
};

export function detectMimeType(filePath: string): string | null {
	const lower = filePath.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot === -1) return null;
	return MIME_BY_EXTENSION[lower.slice(dot)] ?? null;
}

export function isMultimodalMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

export function basenameFromPath(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}
export const MAX_LINE_LENGTH = 10_000;
export const TOOL_RESULT_TOKEN_LIMIT = 20_000;
export const TRUNCATION_GUIDANCE =
	"... [results truncated, try being more specific with your parameters]";

export function fileDataToString(fileData: FileData): string {
	if (typeof fileData.content === "string") return fileData.content;
	if (fileData.content instanceof Uint8Array) {
		return new TextDecoder().decode(fileData.content);
	}
	return fileData.content.join("\n");
}

export function formatContentWithLineNumbers(
	content: string | string[],
	startLine = 1,
): string {
	const lines = typeof content === "string" ? content.split("\n") : content;
	const normalizedLines =
		typeof content === "string" &&
		lines.length > 0 &&
		lines[lines.length - 1] === ""
			? lines.slice(0, -1)
			: lines;

	const result: string[] = [];

	for (let index = 0; index < normalizedLines.length; index += 1) {
		const line = normalizedLines[index] ?? "";
		const lineNumber = index + startLine;

		if (line.length <= MAX_LINE_LENGTH) {
			result.push(`${lineNumber.toString().padStart(6)}\t${line}`);
			continue;
		}

		const chunks = Math.ceil(line.length / MAX_LINE_LENGTH);
		for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
			const start = chunkIndex * MAX_LINE_LENGTH;
			const end = Math.min(start + MAX_LINE_LENGTH, line.length);
			const chunk = line.slice(start, end);
			const marker =
				chunkIndex === 0
					? lineNumber.toString()
					: `${lineNumber}.${chunkIndex}`;
			result.push(`${marker.padStart(6)}\t${chunk}`);
		}
	}

	return result.join("\n");
}

export function formatReadResponse(
	fileData: FileData,
	offset: number,
	limit: number,
): string {
	const content = fileDataToString(fileData);
	if (content.trim() === "") {
		return EMPTY_CONTENT_WARNING;
	}

	const lines = content.split("\n");
	const startIndex = offset;
	const endIndex = Math.min(startIndex + limit, lines.length);

	if (startIndex >= lines.length) {
		return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`;
	}

	return formatContentWithLineNumbers(
		lines.slice(startIndex, endIndex),
		startIndex + 1,
	);
}

export function truncateIfTooLong(result: string[]): string[];
export function truncateIfTooLong(result: string): string;
export function truncateIfTooLong(
	result: string[] | string,
): string[] | string {
	if (Array.isArray(result)) {
		const totalChars = result.reduce((sum, item) => sum + item.length, 0);
		if (totalChars > TOOL_RESULT_TOKEN_LIMIT * 4) {
			const truncateAt = Math.floor(
				(result.length * TOOL_RESULT_TOKEN_LIMIT * 4) / totalChars,
			);
			return [...result.slice(0, truncateAt), TRUNCATION_GUIDANCE];
		}
		return result;
	}

	if (result.length > TOOL_RESULT_TOKEN_LIMIT * 4) {
		return `${result.substring(0, TOOL_RESULT_TOKEN_LIMIT * 4)}\n${TRUNCATION_GUIDANCE}`;
	}

	return result;
}
