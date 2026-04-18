import { context, tool } from "langchain";
import { z } from "zod";
import { normalizePath } from "../backends";
import type { WorkspaceBackend } from "../backends/types";
import type { AccessStore, ScopeKind } from "../server/access_store";

const SHARE_TOOL_PROMPT = context`Create a time-limited web link that lets the user browse or download files from their
own virtual filesystem in a browser.

Use this when the user wants to retrieve one or several artifacts you produced, and a
single \`send_file\` is not a good fit (multiple files, an entire folder, or a file the
user might want to preview inline in a browser).

Scope options:
- Omit \`scope_path\` (default \`/\`) to share the whole namespace.
- Pass a directory like \`/reports/\` to share that folder and everything under it.
- Pass a file like \`/reports/q1.md\` to share that single file only.

Returns the shareable URL plus expiry. The link expires in at most 24 hours.`;

const GRANT_HOURS_MAX = 24;

interface GrantFsAccessOptions {
	access: AccessStore;
	workspace: WorkspaceBackend;
	callerId: string;
	publicBaseUrl: string;
}

async function classifyScopePath(
	workspace: WorkspaceBackend,
	rawPath: string,
): Promise<
	| { ok: true; scopePath: string; scopeKind: ScopeKind }
	| { ok: false; error: string }
> {
	if (rawPath === "/" || rawPath === "") {
		return { ok: true, scopePath: "/", scopeKind: "root" };
	}
	const looksLikeDir = rawPath.endsWith("/");
	if (looksLikeDir) {
		try {
			const normalized = normalizePath(rawPath, "dir");
			const entries = await workspace.lsInfo(normalized);
			if (entries.length === 0 && normalized !== "/") {
				return {
					ok: false,
					error: `directory '${normalized}' is empty or does not exist`,
				};
			}
			return { ok: true, scopePath: normalized, scopeKind: "dir" };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	try {
		const normalized = normalizePath(rawPath, "file");
		if (!workspace.downloadFiles) {
			return { ok: false, error: "workspace does not support file download" };
		}
		const downloads = await workspace.downloadFiles([normalized]);
		const [download] = downloads;
		if (!download || download.error === "file_not_found") {
			return { ok: false, error: `file '${normalized}' not found` };
		}
		if (download.error) {
			return { ok: false, error: download.error };
		}
		return { ok: true, scopePath: normalized, scopeKind: "file" };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function trimTrailingSlash(base: string): string {
	return base.endsWith("/") ? base.slice(0, -1) : base;
}

export function buildShareUrl(
	publicBaseUrl: string,
	linkUuid: string,
	scopePath: string,
): string {
	const base = trimTrailingSlash(publicBaseUrl);
	const suffix = scopePath === "/" ? "/" : scopePath;
	return `${base}/${linkUuid}${suffix}`;
}

export function createGrantFsAccessTool(options: GrantFsAccessOptions) {
	return tool(
		async ({
			scope_path,
			ttl_hours,
			note,
		}: {
			scope_path?: string;
			ttl_hours?: number;
			note?: string;
		}) => {
			const rawPath = scope_path ?? "/";
			const classification = await classifyScopePath(
				options.workspace,
				rawPath,
			);
			if (!classification.ok) {
				return `Error: cannot share — ${classification.error}`;
			}

			const hours = Math.min(
				Math.max(ttl_hours ?? GRANT_HOURS_MAX, 0.1),
				GRANT_HOURS_MAX,
			);
			const ttlMs = Math.floor(hours * 60 * 60 * 1000);

			const grant = options.access.issue(options.callerId, {
				ttlMs,
				scopePath: classification.scopePath,
				scopeKind: classification.scopeKind,
			});

			const url = buildShareUrl(
				options.publicBaseUrl,
				grant.linkUuid,
				grant.scopePath,
			);
			const expiresAtIso = new Date(grant.expiresAt).toISOString();

			const parts = [
				`Share link created: ${url}`,
				`Scope: ${grant.scopeKind} (${grant.scopePath})`,
				`Expires: ${expiresAtIso}`,
			];
			if (note) parts.push(`Note: ${note}`);
			return parts.join("\n");
		},
		{
			name: "grant_fs_access",
			description: SHARE_TOOL_PROMPT,
			schema: z.object({
				scope_path: z
					.string()
					.optional()
					.describe(
						"Virtual FS path to share. '/' or omit for the whole namespace. Use a trailing slash for a directory (e.g. '/reports/'). Without a trailing slash it's treated as a single-file share.",
					),
				ttl_hours: z
					.number()
					.positive()
					.max(GRANT_HOURS_MAX)
					.optional()
					.describe(
						`Lifetime of the link in hours. Defaults to ${GRANT_HOURS_MAX}h. Capped at ${GRANT_HOURS_MAX}h.`,
					),
				note: z
					.string()
					.optional()
					.describe("Optional note delivered alongside the link in the chat."),
			}),
		},
	);
}
