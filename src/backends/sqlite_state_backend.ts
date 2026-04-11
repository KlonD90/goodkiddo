import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, posix as path } from "node:path";
import type {
	BackendProtocol,
	EditResult,
	FileData,
	FileDownloadResponse,
	FileInfo,
	FilesystemMiddlewareOptions,
	FileUploadResponse,
	GrepMatch,
	WriteResult,
} from "deepagents";
import { createFilesystemMiddleware } from "deepagents";

const DEFAULT_DB_PATH = "./.top-fedder/state.sqlite";
const DEFAULT_NAMESPACE = "default";
const EMPTY_CONTENT_WARNING =
	"System reminder: File exists but has empty contents";
const MAX_LINE_LENGTH = 10_000;

type SqliteFileRow = {
	path: string;
	content: string;
	created_at: string;
	modified_at: string;
};

export interface SqliteStateBackendOptions {
	dbPath?: string;
	namespace?: string;
}

export interface SqliteFilesystemMiddlewareOptions
	extends Omit<FilesystemMiddlewareOptions, "backend">,
		SqliteStateBackendOptions {}

function normalizePath(input: string, kind: "file" | "dir"): string {
	const raw = (input || "/").trim().replaceAll("\\", "/");
	if (!raw) {
		if (kind === "dir") return "/";
		throw new Error("Path cannot be empty");
	}
	if (/^[A-Za-z]:\//.test(raw)) {
		throw new Error("Windows-style absolute paths are not supported");
	}
	let normalized = path.normalize(raw.startsWith("/") ? raw : `/${raw}`);
	if (!normalized.startsWith("/")) normalized = `/${normalized}`;

	if (normalized.split("/").includes("..") || normalized.includes("~")) {
		throw new Error("Path traversal or forbidden characters detected");
	}
	if (kind === "dir")
		return normalized === "/" ? "/" : `${normalized.replace(/\/+$/, "")}/`;
	if (normalized === "/")
		throw new Error("File path must not be the filesystem root");
	return normalized.replace(/\/+$/, "");
}

function splitContent(content: string): string[] {
	return content.split("\n");
}

function fileDataToString(fileData: FileData): string {
	return fileData.content.join("\n");
}

function createFileData(content: string, createdAt?: string): FileData {
	const now = new Date().toISOString();
	return {
		content: splitContent(content),
		created_at: createdAt ?? now,
		modified_at: now,
	};
}

function updateFileData(existing: FileData, content: string): FileData {
	return {
		content: splitContent(content),
		created_at: existing.created_at,
		modified_at: new Date().toISOString(),
	};
}

function formatContentWithLineNumbers(
	content: string[],
	startLine = 1,
): string {
	const result: string[] = [];

	for (let index = 0; index < content.length; index += 1) {
		const line = content[index] ?? "";
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

function formatReadResponse(
	fileData: FileData,
	offset: number,
	limit: number,
): string {
	const content = fileDataToString(fileData);
	if (content.trim() === "") return EMPTY_CONTENT_WARNING;

	const lines = splitContent(content);
	const start = offset;
	const end = Math.min(start + limit, lines.length);

	if (start >= lines.length) {
		return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`;
	}

	return formatContentWithLineNumbers(lines.slice(start, end), start + 1);
}

function performStringReplacement(
	content: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
): [string, number] | string {
	if (content === "" && oldString === "") return [newString, 0];
	if (oldString === "")
		return "Error: oldString cannot be empty when file has content";

	const occurrences = content.split(oldString).length - 1;
	if (occurrences === 0)
		return `Error: String not found in file: '${oldString}'`;
	if (occurrences > 1 && !replaceAll) {
		return `Error: String '${oldString}' has multiple occurrences (appears ${occurrences} times) in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.`;
	}

	return [content.split(oldString).join(newString), occurrences];
}

function basenameMatches(pattern: string, filePath: string): boolean {
	return new Bun.Glob(pattern).match(path.basename(filePath));
}

function relativeToDirectory(dirPath: string, filePath: string): string {
	const normalizedDir = normalizePath(dirPath, "dir");
	let relative = filePath.slice(normalizedDir.length);
	if (relative.startsWith("/")) relative = relative.slice(1);
	if (relative) return relative;
	return path.basename(filePath);
}

export class SqliteStateBackend implements BackendProtocol {
	private readonly database: Database;
	private readonly namespace: string;

	constructor(options: SqliteStateBackendOptions = {}) {
		const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}

		this.database = new Database(dbPath, { create: true });
		this.namespace = options.namespace ?? DEFAULT_NAMESPACE;

		this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_files (
        namespace TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        PRIMARY KEY (namespace, path)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_files_namespace_path
      ON agent_files(namespace, path);
    `);
	}

	private mapRowToFileData(row: SqliteFileRow): FileData {
		return {
			content: splitContent(row.content),
			created_at: row.created_at,
			modified_at: row.modified_at,
		};
	}

	private getRow(filePath: string): SqliteFileRow | null {
		const normalizedPath = normalizePath(filePath, "file");
		const statement = this.database.query<SqliteFileRow, [string, string]>(`
      SELECT path, content, created_at, modified_at
      FROM agent_files
      WHERE namespace = ?1 AND path = ?2
    `);

		return statement.get(this.namespace, normalizedPath) ?? null;
	}

	private listRowsInDirectory(dirPath: string): SqliteFileRow[] {
		const normalizedDir = normalizePath(dirPath, "dir");
		const statement = this.database.query<SqliteFileRow, [string, string]>(`
      SELECT path, content, created_at, modified_at
      FROM agent_files
      WHERE namespace = ?1 AND path LIKE ?2
      ORDER BY path ASC
    `);

		return statement.all(this.namespace, `${normalizedDir}%`);
	}

	private listAllRows(): SqliteFileRow[] {
		const statement = this.database.query<SqliteFileRow, [string]>(`
      SELECT path, content, created_at, modified_at
      FROM agent_files
      WHERE namespace = ?1
      ORDER BY path ASC
    `);

		return statement.all(this.namespace);
	}

	lsInfo(dirPath: string): FileInfo[] {
		const normalizedDir = normalizePath(dirPath, "dir");
		const rows = this.listRowsInDirectory(normalizedDir);
		const infos: FileInfo[] = [];
		const subdirs = new Set<string>();

		for (const row of rows) {
			const relative = row.path.slice(normalizedDir.length);
			if (!relative) continue;

			if (relative.includes("/")) {
				const firstSegment = relative.split("/")[0];
				if (firstSegment) subdirs.add(`${normalizedDir}${firstSegment}/`);
				continue;
			}

			infos.push({
				path: row.path,
				is_dir: false,
				size: row.content.length,
				modified_at: row.modified_at,
			});
		}

		for (const subdir of [...subdirs].sort()) {
			infos.push({
				path: subdir,
				is_dir: true,
				size: 0,
				modified_at: "",
			});
		}

		return infos.sort((left, right) => left.path.localeCompare(right.path));
	}

	read(filePath: string, offset = 0, limit = 500): string {
		try {
			return formatReadResponse(this.readRaw(filePath), offset, limit);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return `Error: ${message}`;
		}
	}

	readRaw(filePath: string): FileData {
		const row = this.getRow(filePath);
		if (!row) {
			const normalizedPath = normalizePath(filePath, "file");
			throw new Error(`File '${normalizedPath}' not found`);
		}
		return this.mapRowToFileData(row);
	}

	write(filePath: string, content: string): WriteResult {
		try {
			const normalizedPath = normalizePath(filePath, "file");
			if (this.getRow(normalizedPath)) {
				return {
					error: `Cannot write to ${normalizedPath} because it already exists. Read and then make an edit, or write to a new path.`,
				};
			}

			const fileData = createFileData(content);
			const statement = this.database.query<
				never,
				[string, string, string, string, string]
			>(`
        INSERT INTO agent_files (namespace, path, content, created_at, modified_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `);
			statement.run(
				this.namespace,
				normalizedPath,
				fileDataToString(fileData),
				fileData.created_at,
				fileData.modified_at,
			);

			return {
				path: normalizedPath,
				filesUpdate: null,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: `Error writing file '${filePath}': ${message}` };
		}
	}

	edit(
		filePath: string,
		oldString: string,
		newString: string,
		replaceAll = false,
	): EditResult {
		try {
			const normalizedPath = normalizePath(filePath, "file");
			const row = this.getRow(normalizedPath);
			if (!row) return { error: `Error: File '${normalizedPath}' not found` };

			const current = this.mapRowToFileData(row);
			const replacement = performStringReplacement(
				fileDataToString(current),
				oldString,
				newString,
				replaceAll,
			);
			if (typeof replacement === "string") return { error: replacement };

			const [updatedContent, occurrences] = replacement;
			const updated = updateFileData(current, updatedContent);
			const statement = this.database.query<
				never,
				[string, string, string, string]
			>(`
        UPDATE agent_files
        SET content = ?3, modified_at = ?4
        WHERE namespace = ?1 AND path = ?2
      `);
			statement.run(
				this.namespace,
				normalizedPath,
				fileDataToString(updated),
				updated.modified_at,
			);

			return {
				path: normalizedPath,
				filesUpdate: null,
				occurrences,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: `Error editing file '${filePath}': ${message}` };
		}
	}

	grepRaw(
		pattern: string,
		searchPath: string | null = "/",
		glob: string | null = null,
	): GrepMatch[] {
		const normalizedDir = normalizePath(searchPath ?? "/", "dir");
		let matcher: RegExp;

		try {
			matcher = new RegExp(pattern);
		} catch {
			return [];
		}

		return this.listAllRows()
			.filter((row) => row.path.startsWith(normalizedDir))
			.filter((row) => (glob ? basenameMatches(glob, row.path) : true))
			.flatMap((row) =>
				splitContent(row.content).flatMap((line, index) =>
					matcher.test(line)
						? [
								{
									path: row.path,
									line: index + 1,
									text: line,
								},
							]
						: [],
				),
			);
	}

	globInfo(pattern: string, searchPath = "/"): FileInfo[] {
		const normalizedDir = normalizePath(searchPath, "dir");
		const glob = new Bun.Glob(pattern);

		return this.listAllRows()
			.filter((row) => row.path.startsWith(normalizedDir))
			.filter((row) => glob.match(relativeToDirectory(normalizedDir, row.path)))
			.sort((left, right) => right.modified_at.localeCompare(left.modified_at))
			.map((row) => ({
				path: row.path,
				is_dir: false,
				size: row.content.length,
				modified_at: row.modified_at,
			}));
	}

	uploadFiles(files: Array<[string, Uint8Array]>): FileUploadResponse[] {
		const upsertStatement = this.database.query<
			never,
			[string, string, string, string, string]
		>(`
      INSERT INTO agent_files (namespace, path, content, created_at, modified_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(namespace, path) DO UPDATE SET
        content = excluded.content,
        modified_at = excluded.modified_at
    `);

		return files.map(([filePath, bytes]) => {
			try {
				const normalizedPath = normalizePath(filePath, "file");
				const existing = this.getRow(normalizedPath);
				const fileData = createFileData(
					new TextDecoder().decode(bytes),
					existing?.created_at,
				);
				upsertStatement.run(
					this.namespace,
					normalizedPath,
					fileDataToString(fileData),
					fileData.created_at,
					fileData.modified_at,
				);
				return { path: normalizedPath, error: null };
			} catch {
				return { path: filePath, error: "invalid_path" };
			}
		});
	}

	downloadFiles(paths: string[]): FileDownloadResponse[] {
		return paths.map((filePath) => {
			try {
				const normalizedPath = normalizePath(filePath, "file");
				const row = this.getRow(normalizedPath);
				if (!row)
					return {
						path: normalizedPath,
						content: null,
						error: "file_not_found",
					};

				return {
					path: normalizedPath,
					content: new TextEncoder().encode(row.content),
					error: null,
				};
			} catch {
				return { path: filePath, content: null, error: "invalid_path" };
			}
		});
	}
}

export function createSqliteFilesystemMiddleware(
	options: SqliteFilesystemMiddlewareOptions = {},
) {
	const { dbPath, namespace, ...middlewareOptions } = options;

	return createFilesystemMiddleware({
		...middlewareOptions,
		backend: new SqliteStateBackend({ dbPath, namespace }),
	});
}
