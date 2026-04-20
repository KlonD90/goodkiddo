// Compaction trigger logic: decides when forced checkpoints should fire and
// executes the compaction when a boundary is crossed.
//
// Defined trigger boundaries:
//   new_thread     — fired by the /new_thread session command
//   message_limit  — fired when stored message count reaches the threshold
//   token_limit    — fired when estimated token count reaches the budget
//   session_resume — reserved for first-message-after-resume (future use)
//   explicit       — caller-initiated checkpoint, no automatic trigger
//
// The threshold functions are pure so they can be tested in isolation.
// runCompaction is the effectful path: it calls the model and persists to SQL.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
	generateCheckpointSummary,
	serializeCheckpointSummary,
} from "../memory/checkpoint_compaction";
import type { ThreadMessage } from "../memory/summarize";
import type {
	ForcedCheckpoint,
	ForcedCheckpointStore,
	SourceBoundary,
} from "./forced_checkpoint_store";

export const DEFAULT_MESSAGE_LIMIT = 50;
export const DEFAULT_TOKEN_BUDGET = 40_000;

export type CompactionThresholds = {
	/** Fire message_limit compaction when stored message count reaches this value. */
	messageLimit?: number;
	/** Fire token_limit compaction when estimated token count reaches this value. */
	tokenBudget?: number;
};

export type CompactionContext = {
	caller: string;
	threadId: string;
	messages: ThreadMessage[];
	pendingMessage?: ThreadMessage;
	model: BaseChatModel;
	store: ForcedCheckpointStore;
};

/**
 * Rough token estimate: 1 token ≈ 4 characters.
 * Intentionally conservative — real tokenizers vary; this is a safe budget guard.
 */
export function estimateTokens(messages: ThreadMessage[]): number {
	return messages.reduce(
		(sum, msg) => sum + (msg.estimatedTokens ?? Math.ceil(msg.content.length / 4)),
		0,
	);
}

/** Returns true when the message count has reached or exceeded the limit. */
export function shouldCompactByMessageLimit(
	messages: ThreadMessage[],
	limit: number,
): boolean {
	return messages.length >= limit;
}

/** Returns true when the estimated token count has reached or exceeded the budget. */
export function shouldCompactByTokenBudget(
	messages: ThreadMessage[],
	budget: number,
): boolean {
	return estimateTokens(messages) >= budget;
}

/**
 * Generate a structured checkpoint summary and persist it to the store.
 * Returns the saved ForcedCheckpoint record.
 */
export async function runCompaction(
	context: CompactionContext,
	sourceBoundary: SourceBoundary,
): Promise<ForcedCheckpoint> {
	const summary = await generateCheckpointSummary(
		context.model,
		context.messages,
	);
	const summaryPayload = serializeCheckpointSummary(summary);
	return context.store.create({
		caller: context.caller,
		threadId: context.threadId,
		sourceBoundary,
		summaryPayload,
	});
}

/**
 * Check message and token thresholds and fire compaction at the first
 * exceeded boundary. Message count is checked before token count.
 *
 * Returns the created ForcedCheckpoint if compaction fired, null otherwise.
 */
export async function maybeCompactByThresholds(
	context: CompactionContext,
	thresholds: CompactionThresholds = {},
): Promise<ForcedCheckpoint | null> {
	const msgLimit = thresholds.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
	const tokenBudget = thresholds.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
	const thresholdMessages = context.pendingMessage
		? [...context.messages, context.pendingMessage]
		: context.messages;

	if (shouldCompactByMessageLimit(thresholdMessages, msgLimit)) {
		return runCompaction(context, "message_limit");
	}

	if (shouldCompactByTokenBudget(thresholdMessages, tokenBudget)) {
		return runCompaction(context, "token_limit");
	}

	return null;
}

/**
 * Placeholder for future session-resume compaction.
 *
 * When session lifecycle support is added, call this on the first incoming
 * message of a resumed session (i.e. when the caller has prior history but
 * the runtime context is being rebuilt). The `session_resume` boundary type
 * is already defined in ForcedCheckpointStore; this function is the intended
 * entry point for that trigger path.
 */
export async function triggerOnSessionResume(
	context: CompactionContext,
): Promise<ForcedCheckpoint> {
	return runCompaction(context, "session_resume");
}
