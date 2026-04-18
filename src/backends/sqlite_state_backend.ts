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
import { fileDataToString, formatReadResponse } from "../utils/filesystem";

const DEFAULT_DB_PATH = "./.top-fedder/state.sqlite";
const DEFAULT_NAMESPACE = "default";
const BINARY_CONTENT_PREFIX = "__top_fedder_binary__:";

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

export function normalizePath(input: string, kind: "file" | "dir"): string {
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

function encodeStoredContent(bytes: Uint8Array): string {
	const decoded = new TextDecoder().decode(bytes);
	const reencoded = new TextEncoder().encode(decoded);
	const isRoundTripEqual =
		reencoded.length === bytes.length &&
		reencoded.every((value, index) => value === bytes[index]);

	if (isRoundTripEqual) {
		return decoded;
	}

	return `${BINARY_CONTENT_PREFIX}${Buffer.from(bytes).toString("base64")}`;
}

function decodeStoredContent(content: string): Uint8Array {
	if (!content.startsWith(BINARY_CONTENT_PREFIX)) {
		return new TextEncoder().encode(content);
	}

	const base64 = content.slice(BINARY_CONTENT_PREFIX.length);
	return Uint8Array.from(Buffer.from(base64, "base64"));
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
					encodeStoredContent(bytes),
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
					content: decodeStoredContent(row.content),
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
