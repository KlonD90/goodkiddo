import { extname } from "node:path";
import type { CapabilityInput, CapabilityResult, FileCapability, FileMetadata } from "../types";

/** Max bytes accepted for a plain-text file (512 KB). */
const TEXT_MAX_BYTES = 512 * 1024;

/**
 * MIME types that are treated as readable text regardless of file extension.
 * Covers `text/*` and common code/data subtypes under `application/`.
 */
const TEXT_MIME_PREFIXES = ["text/"];

const TEXT_APPLICATION_MIME_TYPES = new Set([
	"application/json",
	"application/javascript",
	"application/typescript",
	"application/x-javascript",
	"application/x-typescript",
	"application/xml",
	"application/x-yaml",
	"application/toml",
	"application/x-sh",
	"application/x-shellscript",
]);

/**
 * Extensions that are always treated as text even when the MIME type is
 * `application/octet-stream` or absent.
 */
const TEXT_EXTENSIONS = new Set([
	"txt", "md", "markdown", "rst",
	"js", "mjs", "cjs",
	"ts", "mts", "cts",
	"jsx", "tsx",
	"json", "jsonc", "json5",
	"yaml", "yml",
	"toml", "ini", "cfg", "conf",
	"xml", "html", "htm", "svg",
	"css", "scss", "sass", "less",
	"sh", "bash", "zsh", "fish",
	"py", "rb", "php", "java", "go", "rs", "c", "cpp", "h", "hpp",
	"cs", "swift", "kt", "kts",
	"sql",
	"graphql", "gql",
	"env", "gitignore", "dockerignore",
	"Dockerfile", "Makefile",
	"lock",
	"log",
]);

function isTextMime(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const base = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return (
		TEXT_MIME_PREFIXES.some((p) => base.startsWith(p)) ||
		TEXT_APPLICATION_MIME_TYPES.has(base)
	);
}

function isTextExtension(filename: string | undefined): boolean {
	if (!filename) return false;
	const ext = extname(filename).slice(1).toLowerCase();
	if (ext !== "" && TEXT_EXTENSIONS.has(ext)) return true;
	// Handle bare filenames like "Dockerfile", "Makefile"
	const base = filename.split("/").pop() ?? filename;
	return TEXT_EXTENSIONS.has(base);
}

export function canHandleTextFile(metadata: FileMetadata): boolean {
	return isTextMime(metadata.mimeType) || isTextExtension(metadata.filename);
}

export function createTextFileCapability(): FileCapability {
	return {
		name: "text_file",
		canHandle: canHandleTextFile,
		prevalidate(metadata: FileMetadata): CapabilityResult | null {
			if (metadata.byteSize !== undefined && metadata.byteSize > TEXT_MAX_BYTES) {
				return {
					ok: false,
					userMessage: `Text file is too large (max ${TEXT_MAX_BYTES / 1024} KB). Please send a smaller file or paste the content directly.`,
				};
			}
			return null;
		},
		async process(input: CapabilityInput): Promise<CapabilityResult> {
			const filename = input.metadata.filename ?? "file.txt";
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
			} catch {
				return {
					ok: false,
					userMessage: "This file does not appear to be valid UTF-8 text.",
				};
			}

			const caption = input.metadata.caption?.trim() ?? "";
			const captionLine = caption !== "" ? `\nCaption: ${JSON.stringify(caption)}` : "";
			const content = `[File: ${filename}]${captionLine}\n${text}\n[/File: ${filename}]`;

			return {
				ok: true,
				value: {
					content,
					currentUserText: caption !== "" ? caption : `User attached ${filename}`,
					commandText: caption,
				},
			};
		},
	};
}
