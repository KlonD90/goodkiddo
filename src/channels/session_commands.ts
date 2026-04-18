import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import { rotateThread } from "../memory/rotate_thread";
import type { AccessStore, ScopeKind } from "../server/access_store";
import { buildShareUrl } from "../tools/share_tools";
import type { ChannelAgentSession } from "./shared";

// Channel-agnostic session-control commands — separate concern from permission
// commands in src/permissions/commands.ts.

export type SessionCommandResult =
	| { handled: false }
	| { handled: true; reply: string };

export type WebShareCommandContext = {
	access: AccessStore;
	publicBaseUrl: string;
	callerId: string;
};

export type SessionCommandContext = {
	session: ChannelAgentSession;
	model: BaseChatModel;
	backend: BackendProtocol;
	mintThreadId: () => string;
	webShare?: WebShareCommandContext;
};

async function handleOpenFs(
	args: string,
	context: WebShareCommandContext,
	backend: BackendProtocol,
): Promise<string> {
	const raw = args.trim();
	const scopePath = raw === "" ? "/" : raw;

	let kind: ScopeKind;
	let normalizedPath = scopePath;
	try {
		if (scopePath === "/") {
			kind = "root";
		} else if (scopePath.endsWith("/")) {
			kind = "dir";
			const entries = await backend.lsInfo(scopePath);
			if (entries.length === 0) {
				return `Directory '${scopePath}' is empty or does not exist.`;
			}
		} else {
			kind = "file";
			if (!backend.downloadFiles) {
				return "Error: backend does not support file download.";
			}
			const downloads = await backend.downloadFiles([scopePath]);
			const [download] = downloads;
			if (!download || download.error === "file_not_found") {
				return `File '${scopePath}' not found.`;
			}
			if (download.error) return `Error: ${download.error}`;
			normalizedPath = download.path;
		}
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : String(error)}`;
	}

	const grant = context.access.issue(context.callerId, {
		scopePath: normalizedPath,
		scopeKind: kind,
	});
	const url = buildShareUrl(
		context.publicBaseUrl,
		grant.linkUuid,
		grant.scopePath,
	);
	const expiresAt = new Date(grant.expiresAt).toISOString();
	return [
		`Share link (${grant.scopeKind} ${grant.scopePath}):`,
		url,
		`Expires: ${expiresAt}`,
	].join("\n");
}

function handleRevokeFs(context: WebShareCommandContext): string {
	const count = context.access.revokeByUser(context.callerId);
	return count === 0
		? "No active share links to revoke."
		: `Revoked ${count} active share link${count === 1 ? "" : "s"}.`;
}

export async function maybeHandleSessionCommand(
	input: string,
	context: SessionCommandContext,
): Promise<SessionCommandResult> {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return { handled: false };

	const firstSpace = trimmed.indexOf(" ");
	const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace))
		.slice(1)
		.toLowerCase()
		.split("@", 1)[0];

	if (command === "new-thread" || command === "new_thread") {
		const { summary, newThreadId } = await rotateThread({
			session: context.session,
			model: context.model,
			backend: context.backend,
			mintThreadId: context.mintThreadId,
		});
		return {
			handled: true,
			reply: [
				`New thread started (${newThreadId}).`,
				"Previous thread summarized into /memory/log.md:",
				summary,
			].join("\n"),
		};
	}

	if (command === "open_fs" || command === "open-fs") {
		if (!context.webShare) {
			return {
				handled: true,
				reply:
					"Web share is not configured. Set WEB_PORT and WEB_PUBLIC_BASE_URL to enable it.",
			};
		}
		const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
		const reply = await handleOpenFs(args, context.webShare, context.backend);
		return { handled: true, reply };
	}

	if (command === "revoke_fs" || command === "revoke-fs") {
		if (!context.webShare) {
			return {
				handled: true,
				reply: "Web share is not configured.",
			};
		}
		return { handled: true, reply: handleRevokeFs(context.webShare) };
	}

	return { handled: false };
}
