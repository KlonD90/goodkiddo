import { normalizePath, SqliteStateBackend } from "../backends";
import { detectMimeType } from "../utils/filesystem";
import {
	type AccessStore,
	type ResolvedGrant,
	withinScope,
} from "./access_store";

type SQL = InstanceType<typeof Bun.SQL>;

export interface WebHandlerOptions {
	access: AccessStore;
	db: SQL;
	dialect: "sqlite" | "postgres";
	publicBaseUrl: string;
}

export type WebHandler = (request: Request) => Promise<Response>;

const DOWNLOAD_COOKIE_NAME = "fs_session";
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

function jsonResponse(
	body: unknown,
	status = 200,
	extraHeaders: Record<string, string> = {},
): Response {
	const headers = new Headers({ "content-type": "application/json" });
	for (const [key, value] of Object.entries(extraHeaders)) {
		headers.set(key, value);
	}
	return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(code: string, status: number): Response {
	return jsonResponse({ error: code }, status);
}

function buildDownloadCookie(
	linkUuid: string,
	bearerToken: string,
	maxAgeSeconds: number,
): string {
	const attrs = [
		`${DOWNLOAD_COOKIE_NAME}=${bearerToken}`,
		`Path=/${linkUuid}`,
		"HttpOnly",
		"SameSite=Strict",
		`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
	];
	return attrs.join("; ");
}

function tryNormalizeRequestedPath(
	rawPath: string,
	kind: "file" | "dir",
): string | null {
	try {
		return normalizePath(rawPath, kind);
	} catch {
		return null;
	}
}

function requireBearer(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match ? match[1].trim() : null;
}

function openWorkspace(
	db: SQL,
	dialect: "sqlite" | "postgres",
	userId: string,
): SqliteStateBackend {
	return new SqliteStateBackend({ db, dialect, namespace: userId });
}

async function readJsonBody(
	request: Request,
): Promise<Record<string, unknown> | null> {
	try {
		const value = await request.json();
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return null;
		}
		return value as Record<string, unknown>;
	} catch {
		return null;
	}
}

function inferRequestedPathKind(rawPath: string): "file" | "dir" {
	return rawPath.endsWith("/") ? "dir" : "file";
}

async function handleBoot(
	grant: ResolvedGrant,
	deepPath: string,
): Promise<Response> {
	let initialPath: string;
	if (deepPath === "" || deepPath === "/") {
		initialPath = grant.scopePath;
	} else {
		const kind: "file" | "dir" = deepPath.endsWith("/") ? "dir" : "file";
		const normalized = tryNormalizeRequestedPath(deepPath, kind);
		if (!normalized) return errorResponse("not_found", 404);
		if (!withinScope(normalized, grant.scopePath, grant.scopeKind)) {
			return errorResponse("not_found", 404);
		}
		initialPath = normalized;
	}

	const boot = {
		bearer: grant.bearerToken,
		scopePath: grant.scopePath,
		scopeKind: grant.scopeKind,
		initialPath,
		linkUuid: grant.linkUuid,
	};

	const maxAgeSeconds = Math.ceil((grant.expiresAt - Date.now()) / 1000);
	const headers = new Headers({
		"content-type": "application/json",
		"cache-control": "no-store",
		"set-cookie": buildDownloadCookie(
			grant.linkUuid,
			grant.bearerToken,
			maxAgeSeconds,
		),
	});
	return new Response(JSON.stringify(boot), { status: 200, headers });
}

async function handleDownload(
	request: Request,
	grant: ResolvedGrant,
	db: SQL,
	dialect: "sqlite" | "postgres",
): Promise<Response> {
	const url = new URL(request.url);
	const rawPath = url.searchParams.get("path");
	if (!rawPath) return errorResponse("missing_path", 400);
	const normalized = tryNormalizeRequestedPath(rawPath, "file");
	if (!normalized) return errorResponse("invalid_path", 400);
	if (!withinScope(normalized, grant.scopePath, grant.scopeKind)) {
		return errorResponse("out_of_scope", 403);
	}

	const workspace = openWorkspace(db, dialect, grant.userId);
	const [result] = await workspace.downloadFiles([normalized]);
	if (!result || result.error === "file_not_found") {
		return errorResponse("file_not_found", 404);
	}
	if (result.error) return errorResponse(result.error, 400);
	if (!result.content) return errorResponse("file_not_found", 404);

	const bytes = result.content;
	if (bytes.length > DOWNLOAD_MAX_BYTES) {
		return errorResponse("file_too_large", 413);
	}
	const mime = detectMimeType(normalized) ?? "application/octet-stream";
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	return new Response(bytes, {
		status: 200,
		headers: {
			"content-type": mime,
			"content-length": String(bytes.length),
			"content-disposition": `attachment; filename="${basename.replace(/"/g, "")}"`,
			"cache-control": "no-store",
		},
	});
}

async function handleApi(
	request: Request,
	access: AccessStore,
	db: SQL,
	dialect: "sqlite" | "postgres",
): Promise<Response> {
	const url = new URL(request.url);
	const route = url.pathname.replace(/^\/api\/fs\//, "");

	if (request.method !== "POST") {
		return errorResponse("method_not_allowed", 405);
	}

	const bearer = requireBearer(request);
	if (!bearer) return errorResponse("unauthorized", 401);
	const grant = await access.resolveBearer(bearer);
	if (!grant) return errorResponse("unauthorized", 401);

	const body = await readJsonBody(request);
	if (!body) return errorResponse("invalid_body", 400);
	const rawPath = typeof body.path === "string" ? body.path : null;
	if (rawPath === null) return errorResponse("missing_path", 400);

	if (route === "ls") {
		if (grant.scopeKind === "file") {
			return errorResponse("out_of_scope", 403);
		}
		const normalized = tryNormalizeRequestedPath(rawPath, "dir");
		if (!normalized) return errorResponse("invalid_path", 400);
		if (!withinScope(normalized, grant.scopePath, grant.scopeKind)) {
			return errorResponse("out_of_scope", 403);
		}
		const workspace = openWorkspace(db, dialect, grant.userId);
		const entries = await workspace.lsInfo(normalized);
		return jsonResponse({ path: normalized, entries });
	}

	if (route === "stat") {
		const kind: "file" | "dir" = inferRequestedPathKind(rawPath);
		const normalized = tryNormalizeRequestedPath(rawPath, kind);
		if (!normalized) return errorResponse("invalid_path", 400);
		if (!withinScope(normalized, grant.scopePath, grant.scopeKind)) {
			return errorResponse("out_of_scope", 403);
		}
		const workspace = openWorkspace(db, dialect, grant.userId);
		if (kind === "dir") {
			const entries = await workspace.lsInfo(normalized);
			return jsonResponse({
				path: normalized,
				is_dir: true,
				size: 0,
				modified_at: "",
				child_count: entries.length,
			});
		}
		const [download] = await workspace.downloadFiles([normalized]);
		if (!download || download.error === "file_not_found") {
			return errorResponse("file_not_found", 404);
		}
		if (download.error) return errorResponse(download.error, 400);
		const size = download.content?.length ?? 0;
		return jsonResponse({
			path: normalized,
			is_dir: false,
			size,
			mime: detectMimeType(normalized),
		});
	}

	if (route === "preview") {
		const normalized = tryNormalizeRequestedPath(rawPath, "file");
		if (!normalized) return errorResponse("invalid_path", 400);
		if (!withinScope(normalized, grant.scopePath, grant.scopeKind)) {
			return errorResponse("out_of_scope", 403);
		}
		const workspace = openWorkspace(db, dialect, grant.userId);
		const [download] = await workspace.downloadFiles([normalized]);
		if (!download || download.error === "file_not_found") {
			return errorResponse("file_not_found", 404);
		}
		if (download.error) return errorResponse(download.error, 400);
		const bytes = download.content ?? new Uint8Array();
		if (bytes.length > PREVIEW_MAX_BYTES) {
			return jsonResponse({
				path: normalized,
				size: bytes.length,
				mime: detectMimeType(normalized) ?? "application/octet-stream",
				too_large: true,
			});
		}
		return jsonResponse({
			path: normalized,
			size: bytes.length,
			mime: detectMimeType(normalized) ?? "application/octet-stream",
			content_base64: Buffer.from(bytes).toString("base64"),
		});
	}

	return errorResponse("not_found", 404);
}

export function createWebHandler(options: WebHandlerOptions): WebHandler {
	const { access, db, dialect } = options;

	return async function handler(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;

		if (
			pathname === "/_boot" ||
			pathname.startsWith("/_boot?") ||
			pathname === "/api/fs/_boot" ||
			pathname.startsWith("/api/fs/_boot?")
		) {
			if (request.method !== "GET") {
				return errorResponse("method_not_allowed", 405);
			}
			const grant = await access.resolveLink(url.searchParams.get("uuid") ?? "");
			if (!grant) return errorResponse("not_found", 404);
			const deepPath = url.searchParams.get("path") ?? "";
			return handleBoot(grant, deepPath);
		}

		if (pathname.startsWith("/api/fs/")) {
			return handleApi(request, access, db, dialect);
		}

		if (pathname === "/_dl" || pathname.startsWith("/_dl?")) {
			if (request.method !== "GET") {
				return errorResponse("method_not_allowed", 405);
			}
			const uuidParam = url.searchParams.get("uuid");
			if (!uuidParam) return errorResponse("missing_uuid", 400);
			const grant = await access.resolveLink(uuidParam);
			if (!grant) return new Response("Unauthorized", { status: 401 });
			return handleDownload(request, grant, db, dialect);
		}

		return new Response("Not found", { status: 404 });
	};
}
