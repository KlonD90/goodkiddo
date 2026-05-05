import { existsSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST_CANDIDATES = [
	resolve(process.cwd(), "web", "dist"),
	resolve(process.cwd(), "..", "web", "dist"),
	resolve(here, "..", "..", "..", "web", "dist"),
];

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

function isPathInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function fsFrontendFallback(): Response {
	return new Response(
		[
			"<!doctype html>",
			'<html lang="en">',
			"<head>",
			'<meta charset="utf-8">',
			'<meta name="viewport" content="width=device-width, initial-scale=1">',
			"<title>Workspace</title>",
			"</head>",
			'<body style="margin:0;background:#f7f6f3;color:#9f2f2d;font-family:sans-serif">',
			'<div style="padding:24px">Frontend bundle unavailable. Run <code>bun run web:build</code> from the repository root.</div>',
			"</body>",
			"</html>",
		].join(""),
		{
			status: 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		},
	);
}

function resolveFrontendPath(pathname: string): string | null {
	if (pathname === "/fs/" || pathname === "/fs/index.html") return "index.html";
	if (!pathname.startsWith("/fs/")) return null;
	try {
		const relativePath = decodeURIComponent(pathname.slice("/fs/".length));
		if (relativePath === "" || relativePath.includes("\0")) return null;
		return relativePath;
	} catch {
		return null;
	}
}

function staticContentType(filePath: string): string {
	const mime = detectMimeType(filePath) ?? "application/octet-stream";
	return mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime;
}

async function handleFsFrontend(
	pathname: string,
	search: string,
): Promise<Response | null> {
	if (pathname === "/fs") {
		return Response.redirect(`/fs/${search}`, 308);
	}

	const relativePath = resolveFrontendPath(pathname);
	if (!relativePath) return null;

	for (const distDir of WEB_DIST_CANDIDATES) {
		const filePath = resolve(distDir, relativePath);
		if (!isPathInside(distDir, filePath) || !existsSync(filePath)) continue;
		const ext = extname(filePath);
		const isAsset = ext === ".js" || ext === ".css";
		return new Response(Bun.file(filePath).stream(), {
			headers: {
				"content-type": staticContentType(filePath),
				"cache-control": isAsset
					? "public, max-age=31536000, immutable"
					: "no-store",
			},
		});
	}

	if (relativePath === "index.html") return fsFrontendFallback();
	return null;
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
		const workspace = openWorkspace(db, dialect, grant.userId);
		const dirRequested = inferRequestedPathKind(rawPath) === "dir";

		if (dirRequested) {
			const normalized = tryNormalizeRequestedPath(rawPath, "dir");
			if (!normalized) return errorResponse("invalid_path", 400);
			if (!withinScope(normalized, grant.scopePath, grant.scopeKind)) {
				return errorResponse("out_of_scope", 403);
			}
			const entries = await workspace.lsInfo(normalized);
			return jsonResponse({
				path: normalized,
				is_dir: true,
				size: 0,
				modified_at: "",
				child_count: entries.length,
			});
		}

		const filePath = tryNormalizeRequestedPath(rawPath, "file");
		if (!filePath) return errorResponse("invalid_path", 400);
		if (!withinScope(filePath, grant.scopePath, grant.scopeKind)) {
			return errorResponse("out_of_scope", 403);
		}
		const [download] = await workspace.downloadFiles([filePath]);
		if (download && !download.error) {
			const size = download.content?.length ?? 0;
			return jsonResponse({
				path: filePath,
				is_dir: false,
				size,
				mime: detectMimeType(filePath),
			});
		}
		if (download?.error && download.error !== "file_not_found") {
			return errorResponse(download.error, 400);
		}

		const dirPath = tryNormalizeRequestedPath(rawPath, "dir");
		if (!dirPath) return errorResponse("file_not_found", 404);
		if (!withinScope(dirPath, grant.scopePath, grant.scopeKind)) {
			return errorResponse("out_of_scope", 403);
		}
		const entries = await workspace.lsInfo(dirPath);
		if (entries.length === 0 && dirPath !== grant.scopePath) {
			return errorResponse("file_not_found", 404);
		}
		return jsonResponse({
			path: dirPath,
			is_dir: true,
			size: 0,
			modified_at: "",
			child_count: entries.length,
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
			const grant = await access.resolveLink(
				url.searchParams.get("uuid") ?? "",
			);
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

		const frontend = await handleFsFrontend(pathname, url.search);
		if (frontend) return frontend;

		return new Response("Not found", { status: 404 });
	};
}
