import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import { type AppAgentBundle, createAppAgent } from "../app";
import type { createTimerTools } from "../capabilities/timers/tools";
import {
	type CompactionThresholds,
	estimateTokens,
	maybeCompactByThresholds,
	previewThresholdBoundary,
	shouldCompactByMinimumContent,
	triggerOnOversizedAttachment,
	triggerOnSessionResume,
} from "../checkpoints/compaction_trigger";
import { ForcedCheckpointStore } from "../checkpoints/forced_checkpoint_store";
import { createPersistentCheckpointer } from "../checkpoints/sql_saver";
import type { AppConfig } from "../config";
import { compactionStatusMessage, type SupportedLocale } from "../i18n/locale";
import { createLogger } from "../logger";
import {
	type CheckpointSummary,
	deserializeCheckpointSummary,
} from "../memory/checkpoint_compaction";

const log = createLogger("compaction.seed");

import { resolveIdentityPrompt } from "../identities/registry";
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
import type { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import { reconcileActiveTasksAtBoundary } from "../tasks/reconcile";
import { TaskStore } from "../tasks/store";
import type { WebShareOptions } from "../tools/factory";
import type { StatusEmitter } from "../tools/status_emitter";
import { ActiveThreadStore } from "./active_thread_store";
import type { OutboundChannel } from "./outbound";

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

export type ChannelCurrentTurnContext = {
	now: Date;
	source: "cli" | "telegram_message" | "scheduler" | "system_clock";
	requiresExplicitTimerTimezone?: boolean;
};

export type ChannelAgentSession = {
	agent: AgentInstance;
	threadId: string;
	workspace: BackendProtocol;
	model: BaseChatModel;
	currentUserText?: string;
	currentTurnContext?: ChannelCurrentTurnContext;
	refreshAgent: () => Promise<void>;
	persistThreadId?: (threadId: string) => Promise<void>;
	/** Latest compacted context injected into rebuilt system prompts until replaced. */
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
	/** Set when memory files injected into the system prompt changed this turn. */
	promptNeedsRefresh?: boolean;
	/** The active identity preset id for this session. Null means server default. */
	selectedIdentityId?: string | null;
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
	const makeBundle = () => {
		const { preset } = resolveIdentityPrompt(session?.selectedIdentityId);
		return createAppAgent(config, {
			db: options.db,
			dialect: options.dialect,
			caller: options.caller,
			store: options.store,
			broker: options.broker,
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
			identityPrompt: preset.prompt,
			onMemoryMutation: () => {
				if (session) session.promptNeedsRefresh = true;
			},
		});
	};
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

	// Resolve the caller's stored identity preference so makeBundle picks it up
	// on the first call and all subsequent refreshAgent() calls.
	const userRecord = await options.store.getUserById(options.caller.id);
	createdSession.selectedIdentityId = userRecord?.identityId ?? null;

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
	log.info("seed set (seedFromCheckpoint)", {
		threadId: session.threadId,
		goal: summary.current_goal,
		decisions: summary.decisions.length,
		constraints: summary.constraints.length,
		unfinished: summary.unfinished_work.length,
		recentTurns: recentTurns.length,
		degraded: summary.degraded === true,
	});
}

/**
 * Build the messages array to pass to agent.invoke() / agent.stream().
 *
 * Active compaction context is injected through the rebuilt system prompt.
 * Current-turn time is added as user-turn metadata so the system prompt stays
 * stable for provider-side prompt caching.
 */
export function buildInvokeMessages(
	session: ChannelAgentSession,
	currentUserMessage: { role: "user"; content: unknown },
): Array<{ role: string; content: unknown }> {
	const currentTurnMetadata = renderCurrentTurnMessageMetadata(
		session.currentTurnContext,
	);
	if (currentTurnMetadata) {
		return [{ role: "user", content: currentTurnMetadata }, currentUserMessage];
	}

	return [currentUserMessage];
}

export function clearPendingCompactionSeed(session: ChannelAgentSession): void {
	if (session.pendingCompactionSeed) {
		log.debug("seed cleared", { threadId: session.threadId });
	}
	session.pendingCompactionSeed = undefined;
}

export function clearPendingTaskCheckContext(
	session: ChannelAgentSession,
): void {
	session.pendingTaskCheckContext = undefined;
}

export async function refreshAgentIfPromptDirty(
	session: ChannelAgentSession,
): Promise<void> {
	if (!session.promptNeedsRefresh) return;
	session.promptNeedsRefresh = false;
	await session.refreshAgent();
}

async function emitCompactionStatus(
	session: ChannelAgentSession,
	caller: string,
): Promise<void> {
	if (!session.statusEmitter) return;
	try {
		await session.statusEmitter.emit(
			caller,
			compactionStatusMessage(session.locale),
		);
	} catch {
		// Status emission is best-effort; compaction proceeds regardless.
	}
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
	const compactionMessages = buildSessionRuntimeMessages(session, messages);
	if (!shouldCompactByMinimumContent(compactionMessages)) {
		session.needsResumeCompaction = false;
		return false;
	}
	await emitCompactionStatus(session, caller);
	const checkpoint = await triggerOnSessionResume({
		caller,
		threadId: session.threadId,
		messages: compactionMessages,
		model: session.model,
		store,
	});
	if (!checkpoint) {
		session.needsResumeCompaction = false;
		return false;
	}

	await rotateSessionThread(session, mintThreadId());
	const resumeSummary = deserializeCheckpointSummary(checkpoint.summaryPayload);
	const resumeRecent = extractRecentTurns(messages, 2);
	session.pendingCompactionSeed = {
		summary: resumeSummary,
		recentTurns: resumeRecent,
	};
	log.info("seed set (session resume)", {
		newThreadId: session.threadId,
		goal: resumeSummary.current_goal,
		decisions: resumeSummary.decisions.length,
		recentTurns: resumeRecent.length,
	});
	return true;
}

export async function compactSessionForOversizedAttachment(
	session: ChannelAgentSession,
	messages: ThreadMessage[],
	mintThreadId: () => string,
): Promise<ThreadMessage[]> {
	if (!session.compactionConfig) {
		throw new Error(
			"Oversized attachment compaction requires session.compactionConfig.",
		);
	}

	const { caller, store } = session.compactionConfig;
	const compactionMessages = buildSessionRuntimeMessages(session, messages);
	const shouldCreateCheckpoint =
		shouldCompactByMinimumContent(compactionMessages);
	if (shouldCreateCheckpoint) {
		await emitCompactionStatus(session, caller);
	}
	const checkpoint = await triggerOnOversizedAttachment({
		caller,
		threadId: session.threadId,
		messages: compactionMessages,
		model: session.model,
		store,
	});

	await rotateSessionThread(session, mintThreadId());
	if (checkpoint) {
		const attachSummary = deserializeCheckpointSummary(
			checkpoint.summaryPayload,
		);
		const attachRecent = extractRecentTurns(messages, 2);
		session.pendingCompactionSeed = {
			summary: attachSummary,
			recentTurns: attachRecent,
		};
		log.info("seed set (oversized attachment)", {
			newThreadId: session.threadId,
			goal: attachSummary.current_goal,
			decisions: attachSummary.decisions.length,
			recentTurns: attachRecent.length,
		});
	}
	await session.refreshAgent();
	return readThreadMessages(session.agent, session.threadId);
}

export async function recoverPendingSeedForEmptyThread(
	session: ChannelAgentSession,
	caller: string,
	store: ForcedCheckpointStore,
): Promise<boolean> {
	const checkpoint = await store.readLatestForCaller(caller);
	if (!checkpoint) {
		log.debug("no stored checkpoint to recover", {
			caller,
			threadId: session.threadId,
		});
		return false;
	}
	if (checkpoint.threadId === session.threadId) {
		log.debug(
			"stored checkpoint belongs to current thread, skipping recovery",
			{
				caller,
				threadId: session.threadId,
			},
		);
		return false;
	}

	log.info("recovering seed from stored checkpoint", {
		caller,
		threadId: session.threadId,
		checkpointId: checkpoint.id,
		priorThreadId: checkpoint.threadId,
		reason: checkpoint.sourceBoundary,
	});
	const priorMessages = await readThreadMessages(
		session.agent,
		checkpoint.threadId,
	);
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
	const compactionMessages = buildSessionRuntimeMessages(session, messages);
	const thresholdMessages = [
		...compactionMessages,
		{
			role: "user" as const,
			content: pendingText === "" ? "[multimodal input]" : pendingText,
			estimatedTokens: estimateContentTokens(pendingUserContent),
		},
	];

	// Only notify the user when compaction is actually about to fire, not on
	// every turn. previewThresholdBoundary mirrors the decision inside
	// maybeCompactByThresholds, so we can emit status without running the LLM.
	if (
		previewThresholdBoundary(thresholdMessages, thresholds) !== null &&
		shouldCompactByMinimumContent(
			compactionMessages,
			thresholds?.minContentChars,
		)
	) {
		await emitCompactionStatus(session, caller);
	}

	const checkpoint = await maybeCompactByThresholds(
		{
			caller,
			threadId: session.threadId,
			messages: compactionMessages,
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
	log.info("seed set (auto compact)", {
		newThreadId: session.threadId,
		reason: checkpoint.sourceBoundary,
		goal: summary.current_goal,
		decisions: summary.decisions.length,
		recentTurns: recentTurns.length,
	});
	return true;
}

export async function prepareSessionForIncomingTurn(
	session: ChannelAgentSession,
	messages: ThreadMessage[],
	pendingUserContent: unknown,
	mintThreadId: () => string,
): Promise<{ currentMessages: ThreadMessage[]; compacted: boolean }> {
	const resumed = await maybeResumeCompactAndSeed(
		session,
		messages,
		mintThreadId,
	);

	let compacted = resumed;
	if (!resumed) {
		compacted = await maybeAutoCompactAndSeed(
			session,
			messages,
			pendingUserContent,
			mintThreadId,
		);
	}

	if (!compacted) {
		return { currentMessages: messages, compacted: false };
	}

	await session.refreshAgent();
	return {
		currentMessages: await readThreadMessages(session.agent, session.threadId),
		compacted: true,
	};
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

export function buildSessionRuntimeMessages(
	session: Pick<
		ChannelAgentSession,
		"pendingCompactionSeed" | "pendingTaskCheckContext"
	>,
	allMessages: ThreadMessage[],
): ThreadMessage[] {
	const runtimeContext = renderSessionRuntimeContext(session);
	if (!runtimeContext) {
		return allMessages;
	}

	return [
		...allMessages,
		{
			role: "system",
			content: runtimeContext,
			estimatedTokens: Math.ceil(runtimeContext.length / 4),
		},
	];
}

export function estimateSessionRuntimeTokens(
	session: Pick<
		ChannelAgentSession,
		"pendingCompactionSeed" | "pendingTaskCheckContext"
	>,
	allMessages: ThreadMessage[],
): number {
	return estimateTokens(buildSessionRuntimeMessages(session, allMessages));
}

function renderSessionRuntimeContext(
	session:
		| Pick<
				ChannelAgentSession,
				"pendingCompactionSeed" | "pendingTaskCheckContext"
		  >
		| undefined,
): string | undefined {
	if (!session) return undefined;
	const blocks: string[] = [];
	if (session.pendingCompactionSeed) {
		const rendered = renderCompactionPromptContext({
			checkpoint: session.pendingCompactionSeed.summary,
			recentTurns: session.pendingCompactionSeed.recentTurns,
		});
		log.info("seed rendered into system prompt", {
			goal: session.pendingCompactionSeed.summary.current_goal,
			recentTurns: session.pendingCompactionSeed.recentTurns.length,
			renderedLength: rendered.length,
		});
		log.debug("seed rendered body", { body: rendered });
		blocks.push(rendered);
	}
	if (session.pendingTaskCheckContext) {
		blocks.push(session.pendingTaskCheckContext.trim());
	}
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

function renderCurrentTurnMessageMetadata(
	context: ChannelCurrentTurnContext | undefined,
): string | undefined {
	if (!context) return undefined;
	const lines = [
		"[Current message metadata]",
		`- Current message time in UTC: ${context.now.toISOString()}`,
		`- Time source: ${formatCurrentTurnTimeSource(context.source)}`,
		"- Do not infer the user's timezone from app configuration.",
	];

	if (context.requiresExplicitTimerTimezone) {
		lines.push(
			'- For duration-only one-time reminders like "in 5 minutes" or "in 30 minutes", do not ask for timezone; compute the UTC target instant from the current message time and call `create_timer` with `type: "once"` and `runAtUtc`.',
			"- For wall-clock one-time reminders or recurring timers, use an explicit IANA timezone from the user request or from `/memory/USER.md` to interpret the requested local time.",
			"- If a wall-clock one-time reminder or recurring timer needs a timezone and none is explicit or stored in `/memory/USER.md`, ask the user for their IANA timezone before calling timer tools.",
			'- After the user provides a timezone, save it to `/memory/USER.md` with `memory_write` using `target: "user"`.',
		);
	}

	lines.push("[/Current message metadata]");
	return lines.join("\n");
}

function formatCurrentTurnTimeSource(
	source: ChannelCurrentTurnContext["source"],
): string {
	switch (source) {
		case "telegram_message":
			return "Telegram message timestamp";
		case "scheduler":
			return "scheduler clock";
		case "cli":
			return "CLI process clock";
		case "system_clock":
			return "system clock";
	}
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
