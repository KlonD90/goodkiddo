import { normalizePath, SqliteStateBackend } from "../backends";
import { detectMimeType } from "../utils/filesystem";
import {
	type AccessStore,
	type ResolvedGrant,
	type ScopeKind,
	withinScope,
} from "./access_store";
import type { FrontendBundle } from "./frontend_build";

export interface WebHandlerOptions {
	access: AccessStore;
	stateDbPath: string;
	bundle: FrontendBundle;
	publicBaseUrl: string;
}

export type WebHandler = (request: Request) => Promise<Response>;

const DOWNLOAD_COOKIE_NAME = "fs_session";
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function errorResponse(code: string, status: number): Response {
	return jsonResponse({ error: code }, status);
}

function renderHtmlShell(options: {
	bundle: FrontendBundle;
	boot: {
		bearer: string;
		scopePath: string;
		scopeKind: ScopeKind;
		initialPath: string;
		linkUuid: string;
	};
}): string {
	const bootJson = JSON.stringify(options.boot)
		.replaceAll("</", "<\\/")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>Workspace</title>
<link rel="stylesheet" href="/${options.boot.linkUuid}/_assets/bundle.css" />
</head>
<body>
<div id="root"></div>
<script>window.__FS_BOOT=${bootJson};</script>
<script src="/${options.boot.linkUuid}/_assets/bundle.js"></script>
</body>
</html>
`;
}

function parseCookies(header: string | null): Map<string, string> {
	const cookies = new Map<string, string>();
	if (!header) return cookies;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const name = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (name !== "") cookies.set(name, value);
	}
	return cookies;
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
	stateDbPath: string,
	userId: string,
): SqliteStateBackend {
	return new SqliteStateBackend({ dbPath: stateDbPath, namespace: userId });
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

function resolveScopeEntryPath(grant: ResolvedGrant): string {
	return grant.scopeKind === "file" ? grant.scopePath : grant.scopePath;
}

function inferRequestedPathKind(rawPath: string): "file" | "dir" {
	return rawPath.endsWith("/") ? "dir" : "file";
}

function handleHtmlShell(
	grant: ResolvedGrant,
	bundle: FrontendBundle,
	deepPath: string,
): Response {
	let initialPath: string;
	if (deepPath === "" || deepPath === "/") {
		initialPath = resolveScopeEntryPath(grant);
	} else {
		const kind: "file" | "dir" = deepPath.endsWith("/") ? "dir" : "file";
		const normalized = tryNormalizeRequestedPath(deepPath, kind);
		if (!normalized) return new Response("Not found", { status: 404 });
		if (!withinScope(normalized, grant.scopePath, grant.scopeKind)) {
			return new Response("Not found", { status: 404 });
		}
		initialPath = normalized;
	}

	const html = renderHtmlShell({
		bundle,
		boot: {
			bearer: grant.bearerToken,
			scopePath: grant.scopePath,
			scopeKind: grant.scopeKind,
			initialPath,
			linkUuid: grant.linkUuid,
		},
	});

	const maxAgeSeconds = Math.ceil((grant.expiresAt - Date.now()) / 1000);
	const headers = new Headers({
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"set-cookie": buildDownloadCookie(
			grant.linkUuid,
			grant.bearerToken,
			maxAgeSeconds,
		),
	});
	return new Response(html, { status: 200, headers });
}

function serveAsset(bundle: FrontendBundle, assetName: string): Response {
	if (assetName === "bundle.js") {
		return new Response(bundle.js, {
			status: 200,
			headers: {
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "public, max-age=3600",
			},
		});
	}
	if (assetName === "bundle.css") {
		return new Response(bundle.css, {
			status: 200,
			headers: {
				"content-type": "text/css; charset=utf-8",
				"cache-control": "public, max-age=3600",
			},
		});
	}
	return new Response("Not found", { status: 404 });
}

async function handleDownload(
	request: Request,
	linkUuid: string,
	access: AccessStore,
	stateDbPath: string,
): Promise<Response> {
	const cookies = parseCookies(request.headers.get("cookie"));
	const bearer = cookies.get(DOWNLOAD_COOKIE_NAME) ?? "";
	const grant = await access.resolveBearer(bearer);
	if (!grant || grant.linkUuid !== linkUuid) {
		return new Response("Unauthorized", { status: 401 });
	}

	const url = new URL(request.url);
	const rawPath = url.searchParams.get("path");
	if (!rawPath) return errorResponse("missing_path", 400);
	const normalized = tryNormalizeRequestedPath(rawPath, "file");
	if (!normalized) return errorResponse("invalid_path", 400);
	if (!withinScope(normalized, grant.scopePath, grant.scopeKind)) {
		return errorResponse("out_of_scope", 403);
	}

	const workspace = openWorkspace(stateDbPath, grant.userId);
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
	stateDbPath: string,
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
		const workspace = openWorkspace(stateDbPath, grant.userId);
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
		const workspace = openWorkspace(stateDbPath, grant.userId);
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
		const workspace = openWorkspace(stateDbPath, grant.userId);
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

const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createWebHandler(options: WebHandlerOptions): WebHandler {
	const { access, stateDbPath, bundle } = options;

	return async function handler(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;

		if (pathname.startsWith("/api/fs/")) {
			return handleApi(request, access, stateDbPath);
		}

		if (pathname === "/" || pathname === "") {
			return new Response("Not found", { status: 404 });
		}

		const afterLeading = pathname.slice(1);
		const firstSlash = afterLeading.indexOf("/");
		const linkUuid =
			firstSlash === -1 ? afterLeading : afterLeading.slice(0, firstSlash);
		const deepPath = firstSlash === -1 ? "" : afterLeading.slice(firstSlash);

		if (!UUID_REGEX.test(linkUuid)) {
			return new Response("Not found", { status: 404 });
		}

		if (deepPath.startsWith("/_assets/")) {
			const assetName = deepPath.slice("/_assets/".length);
			const grant = await access.resolveLink(linkUuid);
			if (!grant) return new Response("Not found", { status: 404 });
			return serveAsset(bundle, assetName);
		}

		if (deepPath === "/_dl" || deepPath.startsWith("/_dl?")) {
			if (request.method !== "GET") {
				return errorResponse("method_not_allowed", 405);
			}
			return handleDownload(request, linkUuid, access, stateDbPath);
		}

		if (request.method !== "GET") {
			return errorResponse("method_not_allowed", 405);
		}

		const grant = await access.resolveLink(linkUuid);
		if (!grant) return new Response("Not found", { status: 404 });

		return handleHtmlShell(grant, bundle, deepPath);
	};
}
