// Structured forced-checkpoint summary generation and serialization.
//
// generateCheckpointSummary prompts the model to produce a structured JSON
// snapshot of operational state — goal, decisions, constraints, unfinished
// work, pending approvals, and important artifacts. This snapshot is stored
// as the summaryPayload in ForcedCheckpointStore and used by the runtime
// context builder (Task 3) to reconstruct the working context without
// replaying full history.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { renderTranscript, type ThreadMessage } from "./summarize";

export type CheckpointSummary = {
	current_goal: string;
	decisions: string[];
	constraints: string[];
	unfinished_work: string[];
	pending_approvals: string[];
	important_artifacts: string[];
};

const EMPTY_SUMMARY: CheckpointSummary = {
	current_goal: "",
	decisions: [],
	constraints: [],
	unfinished_work: [],
	pending_approvals: [],
	important_artifacts: [],
};

const STRUCTURED_SUMMARY_SYSTEM = [
	"You summarize a conversation that is about to be compacted into a checkpoint.",
	"Output ONLY a JSON object with these exact keys:",
	'  "current_goal": string — the user\'s primary active goal at the end of the conversation',
	'  "decisions": string[] — decisions made or agreed upon',
	'  "constraints": string[] — hard requirements or rules in effect',
	'  "unfinished_work": string[] — tasks or threads that were not completed',
	'  "pending_approvals": string[] — items waiting for user approval or confirmation',
	'  "important_artifacts": string[] — file paths, IDs, URLs, or named outputs produced',
	"Be terse. No preamble. No explanation. Pure JSON only.",
].join("\n");

function extractJson(text: string): string {
	const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch?.[1]) return fenceMatch[1].trim();
	const objMatch = text.match(/\{[\s\S]*\}/);
	if (objMatch) return objMatch[0];
	return text.trim();
}

function contentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "string"
					? part
					: typeof part === "object" && part !== null && "text" in part
						? String((part as { text: unknown }).text ?? "")
						: "",
			)
			.join("");
	}
	return String(content);
}

function normalizeSummary(parsed: Partial<CheckpointSummary>): CheckpointSummary {
	const toStringArray = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

	return {
		current_goal:
			typeof parsed.current_goal === "string" ? parsed.current_goal : "",
		decisions: toStringArray(parsed.decisions),
		constraints: toStringArray(parsed.constraints),
		unfinished_work: toStringArray(parsed.unfinished_work),
		pending_approvals: toStringArray(parsed.pending_approvals),
		important_artifacts: toStringArray(parsed.important_artifacts),
	};
}

export async function generateCheckpointSummary(
	model: BaseChatModel,
	messages: ThreadMessage[],
): Promise<CheckpointSummary> {
	if (messages.length === 0) return { ...EMPTY_SUMMARY };

	const transcript = renderTranscript(messages);
	const response = await model.invoke([
		{ role: "system", content: STRUCTURED_SUMMARY_SYSTEM },
		{ role: "user", content: transcript },
	]);

	const raw = contentToString(response.content).trim();
	const jsonStr = extractJson(raw);

	try {
		const parsed = JSON.parse(jsonStr) as Partial<CheckpointSummary>;
		return normalizeSummary(parsed);
	} catch {
		// Model returned non-parseable output — preserve raw text as the goal
		// so at least partial operational state survives compaction.
		return { ...EMPTY_SUMMARY, current_goal: raw };
	}
}

export function serializeCheckpointSummary(summary: CheckpointSummary): string {
	return JSON.stringify(summary);
}

export function deserializeCheckpointSummary(payload: string): CheckpointSummary {
	try {
		const parsed = JSON.parse(payload) as Partial<CheckpointSummary>;
		return normalizeSummary(parsed);
	} catch {
		return { ...EMPTY_SUMMARY };
	}
}
