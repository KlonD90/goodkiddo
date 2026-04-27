// Compaction trigger logic: decides when forced checkpoints should fire and
// executes the compaction when a boundary is crossed.
//
// Defined trigger boundaries:
//   new_thread     — fired by the /new_thread session command
//   message_limit  — fired when stored message count reaches the threshold
//   token_limit    — fired when estimated token count reaches the budget
//   oversized_attachment — fired to make room before injecting a large attachment
//   session_resume — reserved for first-message-after-resume (future use)
//   explicit       — caller-initiated checkpoint, no automatic trigger
//
// The threshold functions are pure so they can be tested in isolation.
// runCompaction is the effectful path: it calls the model and persists to SQL.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createLogger } from "../logger";
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

const log = createLogger("compaction");

export const DEFAULT_MESSAGE_LIMIT = 50;
export const DEFAULT_TOKEN_BUDGET = 150_000;
export const DEFAULT_MIN_COMPACTION_CONTENT_CHARS = 20_000;

export type CompactionThresholds = {
	/** Fire message_limit compaction when stored message count reaches this value. */
	messageLimit?: number;
	/** Fire token_limit compaction when estimated token count reaches this value. */
	tokenBudget?: number;
	/** Skip compaction when prior meaningful text is below this character count. */
	minContentChars?: number;
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
		(sum, msg) =>
			sum + (msg.estimatedTokens ?? Math.ceil(msg.content.length / 4)),
		0,
	);
}

export function countMeaningfulCompactionChars(
	messages: ThreadMessage[],
): number {
	return messages.reduce((sum, msg) => sum + msg.content.trim().length, 0);
}

export function shouldCompactByMinimumContent(
	messages: ThreadMessage[],
	minContentChars = DEFAULT_MIN_COMPACTION_CONTENT_CHARS,
): boolean {
	if (messages.length === 0) return false;
	return countMeaningfulCompactionChars(messages) >= minContentChars;
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
 * Preview the boundary that would fire for the given thresholds, without
 * running compaction. Callers use this to decide whether to emit a
 * user-facing "compacting…" status before the blocking LLM summary call.
 * Mirrors the precedence inside `maybeCompactByThresholds`.
 */
export function previewThresholdBoundary(
	messages: ThreadMessage[],
	thresholds: CompactionThresholds = {},
): "message_limit" | "token_limit" | null {
	const msgLimit = thresholds.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
	const tokenBudget = thresholds.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
	const minContentChars =
		thresholds.minContentChars ?? DEFAULT_MIN_COMPACTION_CONTENT_CHARS;
	if (!shouldCompactByMinimumContent(messages, minContentChars)) return null;
	if (shouldCompactByMessageLimit(messages, msgLimit)) return "message_limit";
	if (shouldCompactByTokenBudget(messages, tokenBudget)) return "token_limit";
	return null;
}

/**
 * Generate a structured checkpoint summary and persist it to the store.
 * Returns the saved ForcedCheckpoint record.
 */
export async function runCompaction(
	context: CompactionContext,
	sourceBoundary: SourceBoundary,
): Promise<ForcedCheckpoint | null> {
	const messageCount = context.messages.length;
	const estimatedTokens = estimateTokens(context.messages);
	const meaningfulChars = countMeaningfulCompactionChars(context.messages);
	if (!shouldCompactByMinimumContent(context.messages)) {
		log.info("compaction skipped: trivial content", {
			reason: sourceBoundary,
			caller: context.caller,
			threadId: context.threadId,
			messageCount,
			estimatedTokens,
			meaningfulChars,
			minContentChars: DEFAULT_MIN_COMPACTION_CONTENT_CHARS,
		});
		return null;
	}
	log.info("compaction starting", {
		reason: sourceBoundary,
		caller: context.caller,
		threadId: context.threadId,
		messageCount,
		estimatedTokens,
	});
	const startedAt = Date.now();
	try {
		const summary = await generateCheckpointSummary(
			context.model,
			context.messages,
		);
		const summaryPayload = serializeCheckpointSummary(summary);
		const record = await context.store.create({
			caller: context.caller,
			threadId: context.threadId,
			sourceBoundary,
			summaryPayload,
		});
		log.info("compaction completed", {
			reason: sourceBoundary,
			caller: context.caller,
			threadId: context.threadId,
			checkpointId: record.id,
			messageCount,
			estimatedTokens,
			degraded: summary.degraded === true,
			durationMs: Date.now() - startedAt,
		});
		return record;
	} catch (err) {
		log.error("compaction failed", {
			reason: sourceBoundary,
			caller: context.caller,
			threadId: context.threadId,
			messageCount,
			estimatedTokens,
			durationMs: Date.now() - startedAt,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
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
	const minContentChars =
		thresholds.minContentChars ?? DEFAULT_MIN_COMPACTION_CONTENT_CHARS;
	const thresholdMessages = context.pendingMessage
		? [...context.messages, context.pendingMessage]
		: context.messages;

	if (!shouldCompactByMinimumContent(context.messages, minContentChars)) {
		return null;
	}

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
): Promise<ForcedCheckpoint | null> {
	return runCompaction(context, "session_resume");
}

export async function triggerOnOversizedAttachment(
	context: CompactionContext,
): Promise<ForcedCheckpoint | null> {
	return runCompaction(context, "oversized_attachment");
}
