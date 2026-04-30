import { compactInline } from "../utils/text";

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

export type AmbiguousContinuationDetection = {
	isAmbiguous: boolean;
	matchedPhrases: string[];
	searchTerms: string[];
};

export type RankedRecallCandidate = RecallCandidateInput & {
	score: number;
	rationale: string[];
};

export type RecallRankingResult = {
	detection: AmbiguousContinuationDetection;
	candidates: RankedRecallCandidate[];
};

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
		pattern: /\b(?:that|the)\s+[\p{L}\p{N}][\p{L}\p{N}-]*/iu,
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

	return {
		...candidate,
		score,
		rationale,
	};
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
