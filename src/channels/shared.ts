import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import { type AppAgentBundle, createAppAgent } from "../app";
import {
	type CompactionThresholds,
	maybeCompactByThresholds,
	triggerOnSessionResume,
} from "../checkpoints/compaction_trigger";
import { ForcedCheckpointStore } from "../checkpoints/forced_checkpoint_store";
import { createPersistentCheckpointer } from "../checkpoints/sql_saver";
import type { AppConfig } from "../config";
import {
	type CheckpointSummary,
	deserializeCheckpointSummary,
} from "../memory/checkpoint_compaction";
import { readThreadMessages } from "../memory/rotate_thread";
import {
	buildRuntimeContext,
	extractRecentTurns,
} from "../memory/runtime_context";
import type { ThreadMessage } from "../memory/summarize";
import type { ApprovalBroker } from "../permissions/approval";
import { FileAuditLogger } from "../permissions/audit";
import type { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import type { WebShareOptions } from "../tools/factory";
import { ActiveThreadStore } from "./active_thread_store";
import type { OutboundChannel } from "./outbound";

export type AgentInstance = AppAgentBundle["agent"];

export type PendingCompactionSeed = {
	summary: CheckpointSummary;
	recentTurns: ThreadMessage[];
};

export type CompactionSessionConfig = {
	caller: string;
	store: ForcedCheckpointStore;
	thresholds?: CompactionThresholds;
};

export type ChannelAgentSession = {
	agent: AgentInstance;
	threadId: string;
	workspace: BackendProtocol;
	model: BaseChatModel;
	refreshAgent: () => Promise<void>;
	persistThreadId?: (threadId: string) => Promise<void>;
	/** Set after compaction so the next agent turn is seeded with checkpoint context. */
	pendingCompactionSeed?: PendingCompactionSeed;
	/** True for the first turn after a persisted thread is resumed. */
	needsResumeCompaction?: boolean;
	/** When set, auto-compaction is checked before each turn. */
	compactionConfig?: CompactionSessionConfig;
};

type SQL = InstanceType<typeof Bun.SQL>;

export async function createChannelAgentSession(
	config: AppConfig,
	options: {
		db: SQL;
		dialect: "sqlite" | "postgres";
		caller: Caller;
		store: PermissionsStore;
		broker: ApprovalBroker;
		threadId: string;
		outbound?: OutboundChannel;
		webShare?: WebShareOptions;
	},
): Promise<ChannelAgentSession> {
	const audit = new FileAuditLogger("./permissions.log");
	const checkpointer = createPersistentCheckpointer(
		options.db,
		options.dialect,
	);
	const forcedCheckpointStore = new ForcedCheckpointStore(options.db);
	const activeThreadStore = new ActiveThreadStore(options.db);
	await forcedCheckpointStore.ready();
	await activeThreadStore.ready();

	const makeBundle = () =>
		createAppAgent(config, {
			db: options.db,
			dialect: options.dialect,
			caller: options.caller,
			store: options.store,
			broker: options.broker,
			audit,
			checkpointer,
			outbound: options.outbound,
			webShare: options.webShare,
		});
	let bundle = await makeBundle();

	const session: ChannelAgentSession = {
		agent: bundle.agent,
		threadId: options.threadId,
		workspace: bundle.workspace,
		model: bundle.model,
		refreshAgent: async () => {
			bundle = await makeBundle();
			session.agent = bundle.agent;
			session.workspace = bundle.workspace;
			session.model = bundle.model;
		},
		persistThreadId: (threadId: string) =>
			activeThreadStore.setActiveThread(options.caller.id, threadId),
		compactionConfig: {
			caller: options.caller.id,
			store: forcedCheckpointStore,
		},
	};

	session.threadId = await activeThreadStore.getOrCreate(
		options.caller.id,
		options.threadId,
	);
	const existingMessages = await readThreadMessages(
		session.agent,
		session.threadId,
	);
	if (existingMessages.length > 0) {
		session.needsResumeCompaction = true;
	} else {
		await recoverPendingSeedForEmptyThread(
			session,
			options.caller.id,
			forcedCheckpointStore,
		);
	}

	return session;
}

/**
 * Seed the session's first turn with a checkpoint from a previously stored
 * compaction record. Call this after session creation when resuming an
 * existing conversation that has at least one forced checkpoint.
 *
 * `allMessages` should be the current thread's stored messages (may be empty
 * for a just-rotated thread). The last 2 turns are extracted and included
 * alongside the checkpoint summary.
 */
export function seedFromCheckpoint(
	session: ChannelAgentSession,
	checkpointPayload: string,
	allMessages: ThreadMessage[],
): void {
	const summary = deserializeCheckpointSummary(checkpointPayload);
	const recentTurns = extractRecentTurns(allMessages, 2);
	session.pendingCompactionSeed = { summary, recentTurns };
}

/**
 * Build the messages array to pass to agent.invoke() / agent.stream().
 *
 * - If the session has a pending compaction seed, this returns
 *   [checkpoint_system_msg, ...recentTurns, currentUserMessage].
 *   The caller must clear the seed only after the seeded turn succeeds.
 * - Otherwise returns [currentUserMessage].
 *
 * The `currentUserMessage.content` is passed through unchanged, so multimodal
 * content (image blocks, etc.) is preserved.
 */
export function buildInvokeMessages(
	session: ChannelAgentSession,
	currentUserMessage: { role: "user"; content: unknown },
): Array<{ role: string; content: unknown }> {
	if (!session.pendingCompactionSeed) {
		return [currentUserMessage];
	}

	const { summary, recentTurns } = session.pendingCompactionSeed;

	const ctx = buildRuntimeContext({
		checkpoint: summary,
		allMessages: recentTurns,
		currentInput:
			typeof currentUserMessage.content === "string"
				? currentUserMessage.content
				: "[multimodal input]",
	});

	// Replace the last message (built by buildRuntimeContext as plain string)
	// with the original currentUserMessage so multimodal content is preserved.
	const seedMessages = ctx.messages.slice(0, -1);
	return [...seedMessages, currentUserMessage];
}

export function clearPendingCompactionSeed(session: ChannelAgentSession): void {
	session.pendingCompactionSeed = undefined;
}

async function rotateSessionThread(
	session: ChannelAgentSession,
	newThreadId: string,
): Promise<void> {
	await session.persistThreadId?.(newThreadId);
	session.threadId = newThreadId;
	session.needsResumeCompaction = false;
}

export async function maybeResumeCompactAndSeed(
	session: ChannelAgentSession,
	messages: ThreadMessage[],
	mintThreadId: () => string,
): Promise<boolean> {
	if (!session.compactionConfig || !session.needsResumeCompaction) return false;
	if (messages.length === 0) {
		session.needsResumeCompaction = false;
		return false;
	}

	const { caller, store } = session.compactionConfig;
	const checkpoint = await triggerOnSessionResume({
		caller,
		threadId: session.threadId,
		messages,
		model: session.model,
		store,
	});

	await rotateSessionThread(session, mintThreadId());
	session.pendingCompactionSeed = {
		summary: deserializeCheckpointSummary(checkpoint.summaryPayload),
		recentTurns: extractRecentTurns(messages, 2),
	};
	return true;
}

export async function recoverPendingSeedForEmptyThread(
	session: ChannelAgentSession,
	caller: string,
	store: ForcedCheckpointStore,
): Promise<boolean> {
	const checkpoint = await store.readLatestForCaller(caller);
	if (!checkpoint || checkpoint.threadId === session.threadId) {
		return false;
	}

	const priorMessages = await readThreadMessages(session.agent, checkpoint.threadId);
	seedFromCheckpoint(session, checkpoint.summaryPayload, priorMessages);
	return true;
}

/**
 * Check message/token thresholds and, when exceeded, create a forced
 * checkpoint, rotate to a new thread, and set a pending compaction seed so
 * the next turn starts with compacted context.
 *
 * `messages` must be the current thread's stored messages, read before this
 * call (e.g. via readThreadMessages from memory/rotate_thread).
 *
 * Returns true when a threshold fired and the thread was rotated.
 */
export async function maybeAutoCompactAndSeed(
	session: ChannelAgentSession,
	messages: ThreadMessage[],
	pendingUserContent: unknown,
	mintThreadId: () => string,
): Promise<boolean> {
	if (!session.compactionConfig) return false;
	const { caller, store, thresholds } = session.compactionConfig;
	const pendingText = extractTextFromContent(pendingUserContent);
	const thresholdMessages = [
		...messages,
		{
			role: "user" as const,
			content: pendingText === "" ? "[multimodal input]" : pendingText,
		},
	];

	const checkpoint = await maybeCompactByThresholds(
		{
			caller,
			threadId: session.threadId,
			messages,
			pendingMessage: thresholdMessages[thresholdMessages.length - 1],
			model: session.model,
			store,
		},
		thresholds,
	);

	if (!checkpoint) return false;

	const recentTurns = extractRecentTurns(messages, 2);
	const summary = deserializeCheckpointSummary(checkpoint.summaryPayload);

	await rotateSessionThread(session, mintThreadId());
	session.pendingCompactionSeed = { summary, recentTurns };
	return true;
}

export const extractTextFromContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => extractTextFromContent(item))
			.filter((item) => item !== "")
			.join("\n");
	}
	if (typeof content === "object" && content !== null) {
		if ("text" in content && typeof content.text === "string") {
			return content.text;
		}
		if ("content" in content) {
			return extractTextFromContent(content.content);
		}
	}
	return "";
};

function isAssistantMessage(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;

	if ("role" in message) {
		const role = message.role;
		if (role === "assistant" || role === "ai") return true;
	}

	if ("getType" in message && typeof message.getType === "function") {
		const type = message.getType();
		if (type === "ai" || type === "assistant") return true;
	}

	return false;
}

export const extractAgentReply = (result: { messages?: unknown[] }): string => {
	const messages = result.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isAssistantMessage(message)) continue;
		const content =
			typeof message === "object" && message !== null && "content" in message
				? extractTextFromContent((message as { content: unknown }).content)
				: "";
		if (content !== "") return content;
	}
	return "The agent completed the task but did not return a text response.";
};
