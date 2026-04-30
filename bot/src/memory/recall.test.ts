import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import type { ForcedCheckpoint } from "../checkpoints/forced_checkpoint_store";
import { createDb, detectDialect } from "../db";
import type { TaskRecord } from "../tasks/store";
import { ensureMemoryBootstrapped } from "./bootstrap";
import { serializeCheckpointSummary } from "./checkpoint_compaction";
import { overwrite } from "./fs";
import { upsertIndexFile } from "./index_manager";
import { MEMORY_INDEX_PATH, MEMORY_LOG_PATH } from "./layout";
import {
	checkpointRecallCandidates,
	collectRecallCandidates,
	detectAmbiguousContinuation,
	formatRecallRuntimeContext,
	memoryRecallCandidates,
	RECALL_CONFIDENCE_POLICY,
	type RecallCandidateInput,
	rankRecallCandidates,
	recallConfidence,
	taskRecallCandidates,
} from "./recall";

const NOW = Date.UTC(2026, 3, 30, 12, 0, 0);

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
	return {
		id: 1,
		userId: "telegram:1",
		threadIdCreated: "thread-a",
		threadIdCompleted: null,
		listName: "today",
		title: "Draft sales proposal",
		note: null,
		status: "active",
		statusReason: null,
		createdAt: NOW - 1_000,
		updatedAt: NOW,
		completedAt: null,
		dismissedAt: null,
		...overrides,
	};
}

function makeCheckpoint(
	overrides: Partial<ForcedCheckpoint>,
): ForcedCheckpoint {
	return {
		id: "checkpoint-1",
		caller: "telegram:1",
		threadId: "thread-a",
		createdAt: new Date(NOW).toISOString(),
		sourceBoundary: "new_thread",
		summaryPayload: serializeCheckpointSummary({
			current_goal: "Prepare the Acme launch proposal",
			decisions: ["Use a concise scope table"],
			constraints: [],
			unfinished_work: ["Add pricing options"],
			pending_approvals: [],
			important_artifacts: ["/memory/notes/acme.md"],
		}),
		...overrides,
	};
}

describe("detectAmbiguousContinuation", () => {
	test.each([
		"continue",
		"same thing as before",
		"what we discussed",
		"that client",
		"the proposal",
		"the thing from yesterday",
	])("detects ambiguous continuation phrasing: %s", (input) => {
		const detection = detectAmbiguousContinuation(input);

		expect(detection.isAmbiguous).toBe(true);
		expect(detection.matchedPhrases.length).toBeGreaterThan(0);
	});

	test.each([
		"Create a new invoice template for March retainers",
		"send the invoice to Acme",
		"open the March report",
		"fix the failing test",
		"update the README",
	])("does not treat a specific request as ambiguous: %s", (input) => {
		const detection = detectAmbiguousContinuation(input);

		expect(detection.isAmbiguous).toBe(false);
		expect(detection.matchedPhrases).toEqual([]);
	});

	test("extracts useful search terms from ambiguous requests", () => {
		const detection = detectAmbiguousContinuation(
			"continue the sales proposal",
		);

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
		expect(result.candidates[0].confidence).toBe("high");
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
		expect(result.candidates[0].confidence).toBe("low");
	});

	test("returns multiple medium and low confidence candidates without certainty", () => {
		const result = rankRecallCandidates({
			input: "the proposal",
			candidates,
			now: NOW,
		});

		expect(result.candidates.map((candidate) => candidate.id)).toEqual([
			"task-1",
			"checkpoint-1",
		]);
		expect(result.candidates.map((candidate) => candidate.confidence)).toEqual([
			"medium",
			"medium",
		]);
		for (const candidate of result.candidates) {
			expect(candidate.rationale).toContain("matched terms: proposal");
			expect(candidate.rationale).not.toContain("confidence: high");
		}

		const lowConfidence = rankRecallCandidates({
			input: "continue",
			candidates,
			now: NOW,
			limit: 3,
		});

		expect(lowConfidence.candidates).toHaveLength(3);
		expect(
			lowConfidence.candidates.every(
				(candidate) => candidate.confidence === "low",
			),
		).toBe(true);
	});

	test("assigns medium confidence to one matching explicit candidate", () => {
		const result = rankRecallCandidates({
			input: "the proposal",
			candidates: [
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
			],
			now: NOW,
		});

		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]?.id).toBe("task-1");
		expect(result.candidates[0]?.confidence).toBe("medium");
		expect(result.candidates[0]?.rationale).toContain("confidence: medium");
	});

	test("falls back to targeted clarification data instead of hallucinating", () => {
		const result = rankRecallCandidates({
			input: "what we discussed",
			candidates: [],
			now: NOW,
		});

		expect(result.detection.isAmbiguous).toBe(true);
		expect(result.detection.matchedPhrases).toContain("what we discussed");
		expect(result.candidates).toEqual([]);
	});

	test("keeps recency-only matches low confidence", () => {
		expect(recallConfidence(4, 0)).toBe("low");
		expect(
			recallConfidence(RECALL_CONFIDENCE_POLICY.high.minimumScore, 0),
		).toBe("low");
	});

	test("documents threshold policy for high and medium confidence", () => {
		expect(RECALL_CONFIDENCE_POLICY.high).toMatchObject({
			minimumScore: 20,
			minimumMatchedTerms: 2,
		});
		expect(RECALL_CONFIDENCE_POLICY.medium).toMatchObject({
			minimumScore: 10,
			minimumMatchedTerms: 1,
		});
	});
});

describe("recall candidate sources", () => {
	test("builds candidates from active task titles and source context", () => {
		const candidates = taskRecallCandidates([
			makeTask({
				id: 7,
				listName: "client",
				title: "Prepare Acme launch proposal",
				note: "Use the March pricing notes",
			}),
		]);

		expect(candidates).toEqual([
			{
				id: "task:7",
				source: "task",
				summary: "client: Prepare Acme launch proposal",
				snippet: "Use the March pricing notes",
				updatedAt: NOW,
			},
		]);
	});

	test("builds candidates from recent checkpoint summaries", () => {
		const candidates = checkpointRecallCandidates([makeCheckpoint({})]);

		expect(candidates[0]?.source).toBe("checkpoint");
		expect(candidates[0]?.summary).toContain(
			"Prepare the Acme launch proposal",
		);
		expect(candidates[0]?.snippet).toContain("Add pricing options");
		expect(candidates[0]?.updatedAt).toBe(NOW);
	});

	test("builds candidates from memory index entries, note bodies, profile, and log", async () => {
		const backend = createBackend("recall-memory-sources");
		await ensureMemoryBootstrapped(backend);
		await upsertIndexFile(backend, MEMORY_INDEX_PATH, {
			slug: "acme-proposal",
			path: "/memory/notes/acme-proposal.md",
			hook: "Launch proposal and pricing notes",
		});
		await overwrite(
			backend,
			"/memory/notes/acme-proposal.md",
			"# Acme Proposal\n\n## Actuel\nUse the three-package pricing table.\n",
		);
		await overwrite(
			backend,
			MEMORY_LOG_PATH,
			"# Log\n\n## [2026-04-29] rotate_thread | Discussed Acme follow-up proposal\n",
		);

		const candidates = await memoryRecallCandidates(backend);
		const acme = candidates.find(
			(candidate) => candidate.id === "memory:acme-proposal",
		);
		const profile = candidates.find(
			(candidate) => candidate.id === "memory:user-profile",
		);
		const log = candidates.find((candidate) => candidate.source === "log");

		expect(acme?.summary).toBe(
			"acme-proposal: Launch proposal and pricing notes",
		);
		expect(acme?.snippet).toContain("three-package pricing table");
		expect(profile?.summary).toBe("User profile");
		expect(log?.summary).toBe(
			"rotate_thread: Discussed Acme follow-up proposal",
		);
	});

	test("honors memory and log limits while keeping newest log entries", async () => {
		const backend = createBackend("recall-memory-limits");
		await ensureMemoryBootstrapped(backend);
		await upsertIndexFile(backend, MEMORY_INDEX_PATH, {
			slug: "alpha-note",
			path: "/memory/notes/alpha-note.md",
			hook: "Alpha note",
		});
		await upsertIndexFile(backend, MEMORY_INDEX_PATH, {
			slug: "beta-note",
			path: "/memory/notes/beta-note.md",
			hook: "Beta note",
		});
		await overwrite(backend, "/memory/notes/alpha-note.md", "Alpha body");
		await overwrite(backend, "/memory/notes/beta-note.md", "Beta body");
		await overwrite(
			backend,
			MEMORY_LOG_PATH,
			[
				"# Log",
				"",
				"## [2026-04-28] old_event | Old context",
				"## [2026-04-30] new_event | New context",
			].join("\n"),
		);

		const candidates = await memoryRecallCandidates(backend, {
			memoryEntries: 1,
			logEntries: 1,
		});

		expect(candidates.map((candidate) => candidate.id)).toContain(
			"memory:alpha-note",
		);
		expect(candidates.map((candidate) => candidate.id)).not.toContain(
			"memory:beta-note",
		);
		expect(
			candidates.filter((candidate) => candidate.source === "log"),
		).toEqual([
			expect.objectContaining({
				id: "log:2026-04-30:2",
				summary: "new_event: New context",
			}),
		]);
	});

	test("collects configured sources and only accepts supplied virtual file candidates", async () => {
		const backend = createBackend("recall-collect-sources");
		await ensureMemoryBootstrapped(backend);
		const result = await collectRecallCandidates({
			userId: "telegram:1",
			taskStore: {
				listActiveTasks: async (userId, limit) => {
					expect(userId).toBe("telegram:1");
					expect(limit).toBe(1);
					return [makeTask({ id: 3, title: "Review sales proposal" })];
				},
			},
			checkpointStore: {
				listRecentForCaller: async (caller, limit) => {
					expect(caller).toBe("telegram:1");
					expect(limit).toBe(1);
					return [makeCheckpoint({ id: "checkpoint-3" })];
				},
			},
			backend,
			virtualFiles: [
				{
					id: "virtual:/proposal.md",
					source: "virtual_file",
					summary: "proposal.md draft",
				},
				{
					id: "memory:wrong-source",
					source: "memory",
					summary: "Should not pass as virtual file",
				},
			],
			limits: {
				activeTasks: 1,
				checkpoints: 1,
				virtualFiles: 5,
			},
		});

		expect(result.map((candidate) => candidate.source)).toContain("task");
		expect(result.map((candidate) => candidate.source)).toContain("checkpoint");
		expect(result.map((candidate) => candidate.source)).toContain("memory");
		expect(result.map((candidate) => candidate.id)).toContain(
			"virtual:/proposal.md",
		);
		expect(result.map((candidate) => candidate.id)).not.toContain(
			"memory:wrong-source",
		);
	});

	test("formats concise one-turn runtime recall context", () => {
		const ranked = rankRecallCandidates({
			input: "continue the sales proposal",
			candidates: [
				{
					id: "task-1",
					source: "task",
					summary: "Draft sales proposal for Acme",
					snippet: "Use the March pricing notes",
					updatedAt: NOW,
				},
			],
			now: NOW,
		});

		const context = formatRecallRuntimeContext(ranked);

		expect(context).toContain("## Recall-on-Ambiguity");
		expect(context).toContain("[high] task: Draft sales proposal for Acme");
		expect(context).toContain("Snippet: Use the March pricing notes");
		expect(context).toContain("High confidence: proceed");
	});
});
