import type { BackendProtocol } from "deepagents";
import type { ForcedCheckpoint } from "../checkpoints/forced_checkpoint_store";
import type { TaskRecord } from "../tasks/store";
import { compactInline } from "../utils/text";
import { deserializeCheckpointSummary } from "./checkpoint_compaction";
import { readModifiedAt, readOrEmpty } from "./fs";
import { parseIndex } from "./index_manager";
import {
	MEMORY_INDEX_PATH,
	MEMORY_LOG_PATH,
	USER_PROFILE_PATH,
} from "./layout";
import { userProfileIsEmpty } from "./user_profile";

export type RecallSource =
	| "task"
	| "checkpoint"
	| "memory"
	| "log"
	| "virtual_file";

export type RecallCandidateInput = {
	id: string;
	source: RecallSource;
	summary: string;
	snippet?: string;
	updatedAt?: number;
};

export type RecallConfidence = "high" | "medium" | "low";

export type AmbiguousContinuationDetection = {
	isAmbiguous: boolean;
	matchedPhrases: string[];
	searchTerms: string[];
};

export type RankedRecallCandidate = RecallCandidateInput & {
	score: number;
	confidence: RecallConfidence;
	rationale: string[];
};

export type RecallRankingResult = {
	detection: AmbiguousContinuationDetection;
	candidates: RankedRecallCandidate[];
};

export type RecallCandidateLimits = {
	activeTasks?: number;
	checkpoints?: number;
	memoryEntries?: number;
	logEntries?: number;
	virtualFiles?: number;
};

export type RecallTaskStore = {
	listActiveTasks(userId: string, limit?: number): Promise<TaskRecord[]>;
};

export type RecallCheckpointStore = {
	listRecentForCaller(
		caller: string,
		limit?: number,
	): Promise<ForcedCheckpoint[]>;
};

export type CollectRecallCandidatesOptions = {
	userId: string;
	taskStore?: RecallTaskStore;
	checkpointStore?: RecallCheckpointStore;
	backend?: BackendProtocol;
	virtualFiles?: RecallCandidateInput[];
	limits?: RecallCandidateLimits;
};

type MemoryRecallCandidateOptions = {
	memoryEntries?: number;
	logEntries?: number;
};

export const RECALL_CONFIDENCE_POLICY = {
	high: {
		minimumScore: 20,
		minimumMatchedTerms: 2,
		description:
			"Proceed only when multiple explicit request terms match a candidate with a strong score.",
	},
	medium: {
		minimumScore: 10,
		minimumMatchedTerms: 1,
		description:
			"Ask for confirmation when one explicit request term or comparable evidence points to a likely match.",
	},
	low: {
		minimumScore: 1,
		minimumMatchedTerms: 0,
		description:
			"Offer candidates or ask targeted clarification when evidence is weak, including bare continuation requests.",
	},
} as const;

const AMBIGUOUS_PATTERNS: Array<{ phrase: string; pattern: RegExp }> = [
	{ phrase: "continue", pattern: /\b(?:continue|carry on|keep going)\b/i },
	{
		phrase: "same thing",
		pattern: /\b(?:same thing|do that again|like before|as before)\b/i,
	},
	{
		phrase: "what we discussed",
		pattern: /\b(?:what we discussed|what we talked about|that discussion)\b/i,
	},
	{
		phrase: "that reference",
		pattern:
			/^(?:that|the)\s+[\p{L}\p{N}][\p{L}\p{N}-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}-]*){0,2}[.!?]*$/iu,
	},
	{
		phrase: "relative prior time",
		pattern: /\b(?:from|since)\s+(?:yesterday|earlier|last time|before)\b/i,
	},
];

const STOP_WORDS = new Set([
	"a",
	"about",
	"again",
	"and",
	"as",
	"before",
	"continue",
	"discussed",
	"do",
	"earlier",
	"from",
	"going",
	"it",
	"keep",
	"last",
	"like",
	"on",
	"same",
	"since",
	"that",
	"the",
	"thing",
	"time",
	"we",
	"what",
	"yesterday",
]);

function tokenize(value: string): string[] {
	const matches = value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu);
	if (!matches) return [];
	return matches.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function pushIfUseful(
	candidates: RecallCandidateInput[],
	candidate: RecallCandidateInput,
): void {
	if (candidate.summary.trim().length === 0) return;
	candidates.push({
		...candidate,
		summary: compactInline(candidate.summary),
		snippet: candidate.snippet ? compactInline(candidate.snippet) : undefined,
	});
}

function parseModifiedAt(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function parseCheckpointCreatedAt(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function checkpointSnippet(checkpoint: ForcedCheckpoint): string {
	const summary = deserializeCheckpointSummary(checkpoint.summaryPayload);
	const parts = [
		summary.current_goal,
		...summary.decisions,
		...summary.constraints,
		...summary.unfinished_work,
		...summary.pending_approvals,
		...summary.important_artifacts,
	].filter((part) => part.trim().length > 0);
	return parts.join(" ");
}

function parseMemoryLog(content: string): RecallCandidateInput[] {
	const candidates: RecallCandidateInput[] = [];
	const entryPattern = /^## \[(\d{4}-\d{2}-\d{2})\]\s+([^|]+)\|\s*(.*)$/gm;
	let match = entryPattern.exec(content);

	while (match !== null) {
		const [, date = "", op = "", detail = ""] = match;
		pushIfUseful(candidates, {
			id: `log:${date}:${candidates.length + 1}`,
			source: "log",
			summary: `${op.trim()}: ${detail.trim()}`,
			updatedAt: parseCheckpointCreatedAt(date),
		});
		match = entryPattern.exec(content);
	}

	return candidates;
}

export function detectAmbiguousContinuation(
	input: string,
): AmbiguousContinuationDetection {
	const normalized = compactInline(input);
	const matchedPhrases = AMBIGUOUS_PATTERNS.filter(({ pattern }) =>
		pattern.test(normalized),
	).map(({ phrase }) => phrase);

	return {
		isAmbiguous: matchedPhrases.length > 0,
		matchedPhrases,
		searchTerms: unique(tokenize(normalized)),
	};
}

export function taskRecallCandidates(
	tasks: TaskRecord[],
): RecallCandidateInput[] {
	const candidates: RecallCandidateInput[] = [];
	for (const task of tasks) {
		pushIfUseful(candidates, {
			id: `task:${task.id}`,
			source: "task",
			summary: `${task.listName}: ${task.title}`,
			snippet: task.note ?? undefined,
			updatedAt: task.updatedAt,
		});
	}
	return candidates;
}

export function checkpointRecallCandidates(
	checkpoints: ForcedCheckpoint[],
): RecallCandidateInput[] {
	const candidates: RecallCandidateInput[] = [];
	for (const checkpoint of checkpoints) {
		const snippet = checkpointSnippet(checkpoint);
		pushIfUseful(candidates, {
			id: `checkpoint:${checkpoint.id}`,
			source: "checkpoint",
			summary: snippet || `${checkpoint.sourceBoundary} checkpoint`,
			snippet,
			updatedAt: parseCheckpointCreatedAt(checkpoint.createdAt),
		});
	}
	return candidates;
}

export async function memoryRecallCandidates(
	backend: BackendProtocol,
	options: MemoryRecallCandidateOptions = {},
): Promise<RecallCandidateInput[]> {
	const memoryEntryLimit = options.memoryEntries ?? 20;
	const logEntryLimit = options.logEntries ?? 20;
	const candidates: RecallCandidateInput[] = [];
	const [memoryIndexRaw, userProfileRaw, logRaw] = await Promise.all([
		readOrEmpty(backend, MEMORY_INDEX_PATH),
		readOrEmpty(backend, USER_PROFILE_PATH),
		readOrEmpty(backend, MEMORY_LOG_PATH),
	]);

	const memoryIndex = parseIndex(memoryIndexRaw);
	for (const entry of memoryIndex.entries.slice(0, memoryEntryLimit)) {
		const [note, modifiedAt] = await Promise.all([
			readOrEmpty(backend, entry.path),
			readModifiedAt(backend, entry.path),
		]);
		pushIfUseful(candidates, {
			id: `memory:${entry.slug}`,
			source: "memory",
			summary: `${entry.slug}: ${entry.hook}`,
			snippet: note,
			updatedAt: parseModifiedAt(modifiedAt),
		});
	}

	if (userProfileRaw.trim().length > 0 && !userProfileIsEmpty(userProfileRaw)) {
		const modifiedAt = await readModifiedAt(backend, USER_PROFILE_PATH);
		pushIfUseful(candidates, {
			id: "memory:user-profile",
			source: "memory",
			summary: "User profile",
			snippet: userProfileRaw,
			updatedAt: parseModifiedAt(modifiedAt),
		});
	}

	candidates.push(...parseMemoryLog(logRaw).slice(-logEntryLimit).reverse());
	return candidates;
}

export async function collectRecallCandidates(
	options: CollectRecallCandidatesOptions,
): Promise<RecallCandidateInput[]> {
	const limits = options.limits ?? {};
	const batches = await Promise.all([
		options.taskStore
			? options.taskStore
					.listActiveTasks(options.userId, limits.activeTasks ?? 20)
					.then(taskRecallCandidates)
			: Promise.resolve([]),
		options.checkpointStore
			? options.checkpointStore
					.listRecentForCaller(options.userId, limits.checkpoints ?? 5)
					.then(checkpointRecallCandidates)
			: Promise.resolve([]),
		options.backend
			? memoryRecallCandidates(options.backend, {
					memoryEntries: limits.memoryEntries,
					logEntries: limits.logEntries,
				})
			: Promise.resolve([]),
		Promise.resolve(
			(options.virtualFiles ?? [])
				.filter((candidate) => candidate.source === "virtual_file")
				.slice(0, limits.virtualFiles ?? 10),
		),
	]);

	return batches.flat();
}

function truncateForRuntimeContext(value: string, maxLength: number): string {
	const normalized = compactInline(value);
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

export function formatRecallRuntimeContext(
	result: RecallRankingResult,
): string | undefined {
	if (!result.detection.isAmbiguous) return undefined;

	const lines = [
		"## Recall-on-Ambiguity",
		"The current user message looks like an ambiguous continuation. Use this source-backed recall evidence before asking the user to repeat themselves.",
		`Matched phrases: ${result.detection.matchedPhrases.join(", ")}`,
	];

	if (result.candidates.length === 0) {
		lines.push(
			"Recall search found no source-backed candidates. Ask one targeted clarification and do not invent missing context.",
		);
		return lines.join("\n");
	}

	lines.push(
		"High confidence: proceed with a brief source mention. Medium confidence: ask confirmation. Low confidence: offer likely candidates or ask one targeted clarification.",
		"Candidates:",
	);
	for (const [index, candidate] of result.candidates.entries()) {
		lines.push(
			`${index + 1}. [${candidate.confidence}] ${candidate.source}: ${truncateForRuntimeContext(candidate.summary, 180)}`,
		);
		if (candidate.snippet) {
			lines.push(
				`   Snippet: ${truncateForRuntimeContext(candidate.snippet, 220)}`,
			);
		}
		lines.push(
			`   Rationale: ${truncateForRuntimeContext(candidate.rationale.join("; "), 180)}`,
		);
	}

	return lines.join("\n");
}

export function rankRecallCandidates(options: {
	input: string;
	candidates: RecallCandidateInput[];
	limit?: number;
	now?: number;
}): RecallRankingResult {
	const detection = detectAmbiguousContinuation(options.input);
	const limit = options.limit ?? 5;
	const now = options.now ?? Date.now();

	if (!detection.isAmbiguous || options.candidates.length === 0) {
		return { detection, candidates: [] };
	}

	const ranked = options.candidates
		.map((candidate) => scoreCandidate(candidate, detection.searchTerms, now))
		.filter((candidate) => candidate.score > 0)
		.sort((a, b) => b.score - a.score || compareRecency(a, b))
		.slice(0, limit);

	return { detection, candidates: ranked };
}

function scoreCandidate(
	candidate: RecallCandidateInput,
	searchTerms: string[],
	now: number,
): RankedRecallCandidate {
	const haystack = tokenize(
		[candidate.summary, candidate.snippet ?? "", candidate.source].join(" "),
	);
	const haystackSet = new Set(haystack);
	const matchedTerms = searchTerms.filter((term) => haystackSet.has(term));
	const rationale: string[] = [];
	let score = 0;
	const hasSearchTerms = searchTerms.length > 0;

	if (matchedTerms.length > 0) {
		score += matchedTerms.length * 10;
		rationale.push(`matched terms: ${matchedTerms.join(", ")}`);
	}

	const recencyScore = scoreRecency(candidate.updatedAt, now);
	if (recencyScore > 0 && (!hasSearchTerms || matchedTerms.length > 0)) {
		score += recencyScore;
		rationale.push("recent context");
	}

	if (!hasSearchTerms && candidate.summary.trim().length > 0) {
		score += 1;
		rationale.push("available context for vague continuation");
	}

	const confidence = recallConfidence(score, matchedTerms.length);
	rationale.push(`confidence: ${confidence}`);

	return {
		...candidate,
		score,
		confidence,
		rationale,
	};
}

export function recallConfidence(
	score: number,
	matchedTermCount: number,
): RecallConfidence {
	if (
		score >= RECALL_CONFIDENCE_POLICY.high.minimumScore &&
		matchedTermCount >= RECALL_CONFIDENCE_POLICY.high.minimumMatchedTerms
	) {
		return "high";
	}

	if (
		score >= RECALL_CONFIDENCE_POLICY.medium.minimumScore &&
		matchedTermCount >= RECALL_CONFIDENCE_POLICY.medium.minimumMatchedTerms
	) {
		return "medium";
	}

	return "low";
}

function scoreRecency(updatedAt: number | undefined, now: number): number {
	if (updatedAt === undefined) return 0;
	const ageMs = Math.max(0, now - updatedAt);
	const oneDay = 24 * 60 * 60 * 1000;
	if (ageMs <= oneDay) return 3;
	if (ageMs <= 7 * oneDay) return 2;
	return 1;
}

function compareRecency(
	a: RecallCandidateInput,
	b: RecallCandidateInput,
): number {
	return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}
