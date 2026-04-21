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
import {
	estimateContentTokens,
	extractContentText,
} from "../memory/message_content";
import { readThreadMessages } from "../memory/rotate_thread";
import {
	extractRecentTurns,
	renderCompactionPromptContext,
} from "../memory/runtime_context";
import type { ThreadMessage } from "../memory/summarize";
import type { ApprovalBroker } from "../permissions/approval";
import { FileAuditLogger } from "../permissions/audit";
import type { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import { reconcileActiveTasksAtBoundary } from "../tasks/reconcile";
import { TaskStore } from "../tasks/store";
import type { WebShareOptions } from "../tools/factory";
import { createTimerTools } from "../capabilities/timers/tools";
import { ActiveThreadStore } from "./active_thread_store";
import type { OutboundChannel } from "./outbound";
import type { StatusEmitter } from "../tools/status_emitter";
import type { SupportedLocale } from "../i18n/locale";

type TimerTools = ReturnType<typeof createTimerTools>;

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

export type TaskCheckSessionConfig = {
	caller: string;
	store: TaskStore;
};

export type ChannelAgentSession = {
	agent: AgentInstance;
	threadId: string;
	workspace: BackendProtocol;
	model: BaseChatModel;
	currentUserText?: string;
	refreshAgent: () => Promise<void>;
	persistThreadId?: (threadId: string) => Promise<void>;
	/** Set after compaction so the next agent turn is seeded with checkpoint context. */
	pendingCompactionSeed?: PendingCompactionSeed;
	/** True for the first substantive turn after session creation or /new_thread. */
	pendingTaskCheck?: boolean;
	/** One-turn runtime context emitted by boundary-based task reconciliation. */
	pendingTaskCheckContext?: string;
	/** True for the first turn after a persisted thread is resumed. */
	needsResumeCompaction?: boolean;
	/** When set, auto-compaction is checked before each turn. */
	compactionConfig?: CompactionSessionConfig;
	/** When set, boundary task reconciliation is checked before the next turn. */
	taskCheckConfig?: TaskCheckSessionConfig;
	/** Emits status messages to the active channel. */
	statusEmitter?: StatusEmitter;
	/** Resolved locale for status message rendering. */
	locale?: SupportedLocale;
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
		timerTools?: TimerTools;
		statusEmitter?: StatusEmitter;
		locale?: SupportedLocale;
	},
): Promise<ChannelAgentSession> {
	const audit = new FileAuditLogger("./permissions.log");
	const checkpointer = createPersistentCheckpointer(
		options.db,
		options.dialect,
	);
	const forcedCheckpointStore = new ForcedCheckpointStore(options.db);
	const activeThreadStore = new ActiveThreadStore(options.db);
	const taskStore = new TaskStore({
		db: options.db,
		dialect: options.dialect,
	});
	await forcedCheckpointStore.ready();
	await activeThreadStore.ready();

	let session: ChannelAgentSession | undefined;
	const makeBundle = () =>
		createAppAgent(config, {
			db: options.db,
			dialect: options.dialect,
			caller: options.caller,
			store: options.store,
			broker: options.broker,
			audit,
			checkpointer,
			threadId: session?.threadId ?? options.threadId,
			currentUserText: session?.currentUserText,
			taskStore,
			outbound: options.outbound,
			runtimeContextBlock: renderSessionRuntimeContext(session),
			webShare: options.webShare,
			timerTools: options.timerTools,
			statusEmitter: options.statusEmitter,
			locale: session?.locale ?? options.locale,
		});
	let bundle = await makeBundle();

	const createdSession: ChannelAgentSession = {
		agent: bundle.agent,
		threadId: options.threadId,
		workspace: bundle.workspace,
		model: bundle.model,
		refreshAgent: async () => {
			bundle = await makeBundle();
			createdSession.agent = bundle.agent;
			createdSession.workspace = bundle.workspace;
			createdSession.model = bundle.model;
		},
		persistThreadId: (threadId: string) =>
			activeThreadStore.setActiveThread(options.caller.id, threadId),
		pendingTaskCheck: true,
		compactionConfig: {
			caller: options.caller.id,
			store: forcedCheckpointStore,
		},
		taskCheckConfig: {
			caller: options.caller.id,
			store: taskStore,
		},
		statusEmitter: options.statusEmitter,
		locale: options.locale,
	};
	session = createdSession;

	createdSession.threadId = await activeThreadStore.getOrCreate(
		options.caller.id,
		options.threadId,
	);
	const existingMessages = await readThreadMessages(
		createdSession.agent,
		createdSession.threadId,
	);
	if (existingMessages.length > 0) {
		createdSession.needsResumeCompaction = true;
	} else {
		await recoverPendingSeedForEmptyThread(
			createdSession,
			options.caller.id,
			forcedCheckpointStore,
		);
	}

	return createdSession;
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
 * Pending compaction context is injected through the rebuilt system prompt so
 * it does not become persisted thread history. The message payload therefore
 * always contains just the actual user turn.
 */
export function buildInvokeMessages(
	session: ChannelAgentSession,
	currentUserMessage: { role: "user"; content: unknown },
): Array<{ role: string; content: unknown }> {
	void session;
	return [currentUserMessage];
}

export function clearPendingCompactionSeed(session: ChannelAgentSession): void {
	session.pendingCompactionSeed = undefined;
}

export function clearPendingTaskCheckContext(
	session: ChannelAgentSession,
): void {
	session.pendingTaskCheckContext = undefined;
}

async function rotateSessionThread(
	session: ChannelAgentSession,
	newThreadId: string,
): Promise<void> {
	const priorThreadId = session.threadId;
	try {
		await session.persistThreadId?.(newThreadId);
	} catch {
		throw new Error(
			`Failed to persist thread ID change from ${priorThreadId} to ${newThreadId}`,
		);
	}
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
			estimatedTokens: estimateContentTokens(pendingUserContent),
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

export async function maybeRunPendingTaskCheck(
	session: ChannelAgentSession,
	currentUserContent: unknown,
): Promise<{ handled: boolean; reply?: string; needsRefresh: boolean }> {
	if (!session.pendingTaskCheck || !session.taskCheckConfig) {
		return { handled: false, needsRefresh: false };
	}

	const messageText = extractTextFromContent(currentUserContent).trim();
	if (messageText === "") {
		return { handled: false, needsRefresh: false };
	}

	const result = await reconcileActiveTasksAtBoundary({
		store: session.taskCheckConfig.store,
		userId: session.taskCheckConfig.caller,
		threadId: session.threadId,
		messageText,
	});
	session.pendingTaskCheck = false;
	session.pendingTaskCheckContext = undefined;

	if (result.kind === "dismiss_confirmation") {
		return {
			handled: true,
			reply: result.reply,
			needsRefresh: false,
		};
	}

	if (result.kind === "completed") {
		session.pendingTaskCheckContext = result.agentContext;
		return { handled: false, needsRefresh: true };
	}

	return { handled: false, needsRefresh: false };
}

export const extractTextFromContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => extractTextFromContent(item))
			.filter((item) => item !== "")
			.join("\n");
	}
	return extractContentText(content);
};

function renderSessionRuntimeContext(
	session: ChannelAgentSession | undefined,
): string | undefined {
	if (!session) return undefined;
	const blocks: string[] = [];
	if (session.pendingCompactionSeed) {
		blocks.push(
			renderCompactionPromptContext({
				checkpoint: session.pendingCompactionSeed.summary,
				recentTurns: session.pendingCompactionSeed.recentTurns,
			}),
		);
	}
	if (session.pendingTaskCheckContext) {
		blocks.push(session.pendingTaskCheckContext.trim());
	}
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

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
