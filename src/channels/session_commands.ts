import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import {
	type CompactionContext,
	runCompaction,
	shouldCompactByMinimumContent,
} from "../checkpoints/compaction_trigger";
import type { ForcedCheckpointStore } from "../checkpoints/forced_checkpoint_store";
import {
	DEFAULT_IDENTITY_ID,
	listPresets,
	resolveIdentityPrompt,
	resolvePreset,
	normalizeId,
} from "../identities/registry";
import { compactionStatusMessage } from "../i18n/locale";
import { deserializeCheckpointSummary } from "../memory/checkpoint_compaction";
import { readThreadMessages, rotateThread } from "../memory/rotate_thread";
import { extractRecentTurns } from "../memory/runtime_context";
import type { PermissionsStore } from "../permissions/store";
import type { AccessStore, ScopeKind } from "../server/access_store";
import type { TaskRecord } from "../tasks/store";
import { buildShareUrl } from "../tools/share_tools";
import { compactInline } from "../utils/text";
import {
	buildSessionRuntimeMessages,
	type ChannelAgentSession,
} from "./shared";

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

export type CompactionCommandContext = {
	caller: string;
	store: ForcedCheckpointStore;
};

export type IdentityCommandContext = {
	store: PermissionsStore;
	callerId: string;
};

export type SessionCommandContext = {
	session: ChannelAgentSession;
	model: BaseChatModel;
	backend: BackendProtocol;
	mintThreadId: () => string;
	now?: () => number;
	webShare?: WebShareCommandContext;
	/** When provided, forced checkpoints are created at defined session boundaries. */
	compaction?: CompactionCommandContext;
	/** When provided, /identity commands are enabled. */
	identity?: IdentityCommandContext;
};

export const NEW_THREAD_ACTIVE_TASK_LIMIT = 8;
export const NEW_THREAD_RECENT_COMPLETED_TASK_LIMIT = 5;
export const NEW_THREAD_RECENT_COMPLETED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function formatTaskReplyBlock(
	heading: string,
	tasks: TaskRecord[],
	options: {
		limit: number;
		emptyText: string;
	} = {
		limit: tasks.length,
		emptyText: "- None.",
	},
): string {
	const visibleTasks = tasks.slice(0, options.limit);
	const lines = [heading];

	if (visibleTasks.length === 0) {
		lines.push(options.emptyText);
		return lines.join("\n");
	}

	for (const task of visibleTasks) {
		const note = task.note ? ` — ${compactInline(task.note)}` : "";
		lines.push(
			`- [${task.id}] ${task.listName}: ${compactInline(task.title)}${note}`,
		);
	}

	if (tasks.length > visibleTasks.length) {
		lines.push(`- ... ${tasks.length - visibleTasks.length} more.`);
	}

	return lines.join("\n");
}

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

	const grant = await context.access.issue(context.callerId, {
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

async function handleRevokeFs(
	context: WebShareCommandContext,
): Promise<string> {
	const count = await context.access.revokeByUser(context.callerId);
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
		let pendingSeed: ChannelAgentSession["pendingCompactionSeed"] | undefined;
		if (context.compaction) {
			const messages = await readThreadMessages(
				context.session.agent,
				context.session.threadId,
			);
			const compactionMessages = buildSessionRuntimeMessages(
				context.session,
				messages,
			);
			const compactionCtx: CompactionContext = {
				caller: context.compaction.caller,
				threadId: context.session.threadId,
				messages: compactionMessages,
				model: context.model,
				store: context.compaction.store,
			};
			if (
				shouldCompactByMinimumContent(compactionMessages) &&
				context.session.statusEmitter
			) {
				try {
					await context.session.statusEmitter.emit(
						context.compaction.caller,
						compactionStatusMessage(context.session.locale),
					);
				} catch {
					// best-effort — compaction proceeds regardless
				}
			}
			const checkpoint = await runCompaction(compactionCtx, "new_thread");

			if (checkpoint) {
				// Seed the first turn in the new thread with the checkpoint context
				// so the model has operational continuity without replaying full history.
				const recentTurns = extractRecentTurns(messages, 2);
				const summaryObj = deserializeCheckpointSummary(
					checkpoint.summaryPayload,
				);
				pendingSeed = {
					summary: summaryObj,
					recentTurns,
				};
			}
		}

		const { summary, newThreadId } = await rotateThread({
			session: context.session,
			model: context.model,
			backend: context.backend,
			mintThreadId: context.mintThreadId,
		});
		context.session.pendingCompactionSeed = pendingSeed;
		if (context.compaction || pendingSeed) {
			context.session.pendingTaskCheck = true;
		}

		const taskStore = context.session.taskCheckConfig?.store;
		const callerId = context.session.taskCheckConfig?.caller;
		const now = context.now ?? Date.now;
		const activeTasks =
			taskStore && callerId
				? await taskStore.listActiveTasks(
						callerId,
						NEW_THREAD_ACTIVE_TASK_LIMIT + 1,
					)
				: [];
		const recentCompletedTasks =
			taskStore && callerId
				? await taskStore.listRecentlyCompletedTasks(callerId, {
						completedSince: now() - NEW_THREAD_RECENT_COMPLETED_WINDOW_MS,
						limit: NEW_THREAD_RECENT_COMPLETED_TASK_LIMIT + 1,
					})
				: [];
		return {
			handled: true,
			reply: [
				`New thread started (${newThreadId}).`,
				"Previous thread summary (saved to /memory/log.md):",
				summary,
				formatTaskReplyBlock("Current active tasks:", activeTasks, {
					limit: NEW_THREAD_ACTIVE_TASK_LIMIT,
					emptyText: "- None.",
				}),
				formatTaskReplyBlock(
					`Recently completed tasks (last ${Math.floor(
						NEW_THREAD_RECENT_COMPLETED_WINDOW_MS / (24 * 60 * 60 * 1000),
					)} days):`,
					recentCompletedTasks,
					{
						limit: NEW_THREAD_RECENT_COMPLETED_TASK_LIMIT,
						emptyText: "- None.",
					},
				),
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
		return { handled: true, reply: await handleRevokeFs(context.webShare) };
	}

	if (command === "identity") {
		if (!context.identity) {
			return {
				handled: true,
				reply: "Identity selection is not configured for this session.",
			};
		}
		const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
		const reply = await handleIdentityCommand(args, context);
		return { handled: true, reply };
	}

	return { handled: false };
}

// ---------------------------------------------------------------------------
// /identity command helpers
// ---------------------------------------------------------------------------

function formatPresetList(): string {
	const presets = listPresets();
	const lines = presets.map((p) => `• *${p.id}* — ${p.label}: ${p.description}`);
	return lines.join("\n");
}

async function handleIdentityCommand(
	args: string,
	context: SessionCommandContext,
): Promise<string> {
	const { session, identity } = context;
	if (!identity) {
		return "Identity selection is not configured for this session.";
	}

	const sub = args.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
	const rest = args.slice(sub.length).trim();

	// /identity  or  /identity list
	if (sub === "" || sub === "list") {
		const currentId = session.selectedIdentityId ?? DEFAULT_IDENTITY_ID;
		const { preset: current } = resolveIdentityPrompt(currentId);
		return [
			`Current identity: *${current.id}* — ${current.label}`,
			"",
			"Available presets:",
			formatPresetList(),
			"",
			"Use `/identity use <preset>` to switch, `/identity reset` to return to default.",
		].join("\n");
	}

	// /identity current
	if (sub === "current") {
		const storedId = session.selectedIdentityId ?? null;
		const { preset, wasFallback } = resolveIdentityPrompt(storedId);
		const source =
			storedId === null
				? "server default"
				: wasFallback
					? `stored as "${storedId}" (stale — falling back to default)`
					: "your preference";
		return `Active identity: *${preset.id}* — ${preset.label} (${source}).`;
	}

	// /identity use <preset>
	if (sub === "use") {
		if (!rest) {
			return `Missing preset name. Usage: \`/identity use <preset>\`\n\nAvailable:\n${formatPresetList()}`;
		}
		const targetPreset = resolvePreset(rest);
		if (!targetPreset) {
			const normalizedRest = normalizeId(rest);
			return [
				`Unknown preset "${normalizedRest}". Available presets:`,
				formatPresetList(),
			].join("\n");
		}

		const currentId = session.selectedIdentityId ?? DEFAULT_IDENTITY_ID;
		if (normalizeId(currentId) === targetPreset.id) {
			return `Already using *${targetPreset.id}* — ${targetPreset.label}. No change.`;
		}

		// Persist preference
		await identity.store.setUserIdentity(identity.callerId, targetPreset.id);
		session.selectedIdentityId = targetPreset.id;

		// Rotate thread with summary seed
		await rotateIdentityThread(context);

		return [
			`Identity switched to *${targetPreset.id}* — ${targetPreset.label}.`,
			"",
			"Started a fresh context for this preset. Previous conversation summarized and saved.",
		].join("\n");
	}

	// /identity reset
	if (sub === "reset") {
		const storedId = session.selectedIdentityId ?? null;
		const defaultPreset = resolveIdentityPrompt(null).preset;

		if (storedId === null || storedId === DEFAULT_IDENTITY_ID) {
			return `Already using the default identity (*${defaultPreset.id}* — ${defaultPreset.label}). No change.`;
		}

		await identity.store.clearUserIdentity(identity.callerId);
		session.selectedIdentityId = null;

		await rotateIdentityThread(context);

		return [
			`Identity reset to default: *${defaultPreset.id}* — ${defaultPreset.label}.`,
			"",
			"Started a fresh context. Previous conversation summarized and saved.",
		].join("\n");
	}

	return [
		`Unknown subcommand "${sub}". Supported forms:`,
		"  `/identity` — show current and available presets",
		"  `/identity list` — list all presets",
		"  `/identity current` — show active preset and source",
		"  `/identity use <preset>` — switch to a preset",
		"  `/identity reset` — return to the server default",
	].join("\n");
}

/**
 * Create a forced checkpoint summary (if compaction context is present and
 * there is enough content), rotate to a fresh thread seeded with that summary,
 * then rebuild the agent with the newly selected identity.
 */
async function rotateIdentityThread(
	context: SessionCommandContext,
): Promise<void> {
	const { session, model, backend, mintThreadId } = context;

	let pendingSeed: ChannelAgentSession["pendingCompactionSeed"] | undefined;

	if (context.compaction) {
		const messages = await readThreadMessages(session.agent, session.threadId);
		const compactionMessages = buildSessionRuntimeMessages(session, messages);
		const compactionCtx: CompactionContext = {
			caller: context.compaction.caller,
			threadId: session.threadId,
			messages: compactionMessages,
			model,
			store: context.compaction.store,
		};

		if (
			shouldCompactByMinimumContent(compactionMessages) &&
			session.statusEmitter
		) {
			try {
				await session.statusEmitter.emit(
					context.compaction.caller,
					compactionStatusMessage(session.locale),
				);
			} catch {
				// best-effort
			}
		}

		const checkpoint = await runCompaction(compactionCtx, "identity_change");
		if (checkpoint) {
			const recentTurns = extractRecentTurns(messages, 2);
			const summaryObj = deserializeCheckpointSummary(checkpoint.summaryPayload);
			pendingSeed = { summary: summaryObj, recentTurns };
		}
	}

	await rotateThread({ session, model, backend, mintThreadId });
	session.pendingCompactionSeed = pendingSeed;

	await session.refreshAgent();
}
