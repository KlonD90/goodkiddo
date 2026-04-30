import { describe, expect, test } from "bun:test";
import {
	detectAmbiguousContinuation,
	rankRecallCandidates,
	type RecallCandidateInput,
} from "./recall";

const NOW = Date.UTC(2026, 3, 30, 12, 0, 0);

describe("detectAmbiguousContinuation", () => {
	test.each([
		"continue",
		"same thing as before",
		"what we discussed",
		"the proposal",
		"the thing from yesterday",
	])("detects ambiguous continuation phrasing: %s", (input) => {
		const detection = detectAmbiguousContinuation(input);

		expect(detection.isAmbiguous).toBe(true);
		expect(detection.matchedPhrases.length).toBeGreaterThan(0);
	});

	test("does not treat a specific request as ambiguous", () => {
		const detection = detectAmbiguousContinuation(
			"Create a new invoice template for March retainers",
		);

		expect(detection.isAmbiguous).toBe(false);
		expect(detection.matchedPhrases).toEqual([]);
	});

	test("extracts useful search terms from ambiguous requests", () => {
		const detection = detectAmbiguousContinuation("continue the sales proposal");

		expect(detection.searchTerms).toEqual(["sales", "proposal"]);
	});
});

describe("rankRecallCandidates", () => {
	const candidates: RecallCandidateInput[] = [
		{
			id: "task-1",
			source: "task",
			summary: "Draft sales proposal for Acme",
			updatedAt: NOW - 60_000,
		},
		{
			id: "memory-1",
			source: "memory",
			summary: "Brand voice notes for website copy",
			updatedAt: NOW - 60_000,
		},
		{
			id: "checkpoint-1",
			source: "checkpoint",
			summary: "Reviewed pricing proposal options last week",
			updatedAt: NOW - 8 * 24 * 60 * 60 * 1000,
		},
	];

	test("returns no candidates when the request is not ambiguous", () => {
		const result = rankRecallCandidates({
			input: "Write a fresh homepage headline",
			candidates,
			now: NOW,
		});

		expect(result.detection.isAmbiguous).toBe(false);
		expect(result.candidates).toEqual([]);
	});

	test("ranks candidates by deterministic term and recency evidence", () => {
		const result = rankRecallCandidates({
			input: "continue the sales proposal",
			candidates,
			now: NOW,
		});

		expect(result.candidates.map((candidate) => candidate.id)).toEqual([
			"task-1",
			"checkpoint-1",
		]);
		expect(result.candidates[0].rationale).toContain(
			"matched terms: sales, proposal",
		);
		expect(result.candidates[0].score).toBeGreaterThan(
			result.candidates[1].score,
		);
	});

	test("uses recent available context for bare continuation requests", () => {
		const result = rankRecallCandidates({
			input: "continue",
			candidates,
			now: NOW,
			limit: 2,
		});

		expect(result.candidates.map((candidate) => candidate.id)).toEqual([
			"task-1",
			"memory-1",
		]);
		expect(result.candidates).toHaveLength(2);
		expect(result.candidates[0].rationale).toContain(
			"available context for vague continuation",
		);
	});
});
