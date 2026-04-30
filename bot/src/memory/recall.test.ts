import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import type { ForcedCheckpoint } from "../checkpoints/forced_checkpoint_store";
import { createDb, detectDialect } from "../db";
import type { TaskRecord } from "../tasks/store";
import { ensureMemoryBootstrapped } from "./bootstrap";
import { serializeCheckpointSummary } from "./checkpoint_compaction";
import { overwrite } from "./fs";
import { upsertIndexFile } from "./index_manager";
import {
	MEMORY_INDEX_PATH,
	MEMORY_LOG_PATH,
	USER_PROFILE_PATH,
} from "./layout";
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
		"that proposal?",
		"the proposal",
		"the client.",
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

	test("preserves relative time intent for yesterday references", () => {
		const detection = detectAmbiguousContinuation("the thing from yesterday");

		expect(detection.relativeTime).toBe("yesterday");
		expect(detection.searchTerms).toEqual([]);
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

	test("returns source-backed candidate shape with confidence rationale", () => {
		const result = rankRecallCandidates({
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

		expect(result.candidates).toEqual([
			expect.objectContaining({
				id: "task-1",
				source: "task",
				summary: "Draft sales proposal for Acme",
				snippet: "Use the March pricing notes",
				confidence: "high",
				rationale: expect.arrayContaining([
					"matched terms: sales, proposal",
					"confidence: high",
				]),
			}),
		]);
		expect(result.candidates[0]?.score).toBeGreaterThanOrEqual(
			RECALL_CONFIDENCE_POLICY.high.minimumScore,
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

	test("does not offer unrelated candidates when explicit terms do not match", () => {
		const result = rankRecallCandidates({
			input: "that client",
			candidates: [
				{
					id: "task-1",
					source: "task",
					summary: "Prepare Acme launch deck",
					updatedAt: NOW - 60_000,
				},
				{
					id: "checkpoint-1",
					source: "checkpoint",
					summary: "Reviewed pricing options",
					updatedAt: NOW - 120_000,
				},
			],
			now: NOW,
		});

		expect(result.candidates).toEqual([]);
	});

	test("does not match generic request terms against source labels", () => {
		const result = rankRecallCandidates({
			input: "that task",
			candidates: [
				{
					id: "task-1",
					source: "task",
					summary: "Prepare Acme launch deck",
					updatedAt: NOW - 60_000,
				},
			],
			now: NOW,
		});

		expect(result.candidates).toEqual([]);
	});

	test("uses yesterday time intent instead of newest generic context", () => {
		const result = rankRecallCandidates({
			input: "the thing from yesterday",
			candidates: [
				{
					id: "today-task",
					source: "task",
					summary: "Today's unrelated task",
					updatedAt: NOW - 60_000,
				},
				{
					id: "yesterday-task",
					source: "task",
					summary: "Yesterday's proposal follow-up",
					updatedAt: NOW - 24 * 60 * 60 * 1000,
				},
			],
			now: NOW,
		});

		expect(result.candidates.map((candidate) => candidate.id)).toEqual([
			"yesterday-task",
		]);
		expect(result.candidates[0]?.rationale).toContain(
			"matches requested yesterday window",
		);
	});

	test("downgrades competing high-confidence matches to confirmation", () => {
		const result = rankRecallCandidates({
			input: "continue the sales proposal",
			candidates: [
				{
					id: "task-1",
					source: "task",
					summary: "Draft sales proposal for Acme",
					updatedAt: NOW - 60_000,
				},
				{
					id: "task-2",
					source: "task",
					summary: "Draft sales proposal for Beta",
					updatedAt: NOW - 120_000,
				},
			],
			now: NOW,
		});

		expect(result.candidates.map((candidate) => candidate.confidence)).toEqual([
			"medium",
			"medium",
		]);
		expect(result.candidates[0]?.rationale).toContain(
			"multiple comparable high-confidence candidates require confirmation",
		);
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

	test("documents threshold policy for high, medium, and low confidence", () => {
		expect(RECALL_CONFIDENCE_POLICY.high).toMatchObject({
			minimumScore: 20,
			minimumMatchedTerms: 2,
		});
		expect(RECALL_CONFIDENCE_POLICY.medium).toMatchObject({
			minimumScore: 10,
			minimumMatchedTerms: 1,
		});
		expect(RECALL_CONFIDENCE_POLICY.low).toMatchObject({
			minimumScore: 1,
			minimumMatchedTerms: 0,
		});
	});

	test("applies exact confidence threshold boundaries", () => {
		expect(recallConfidence(20, 2)).toBe("high");
		expect(recallConfidence(19, 2)).toBe("medium");
		expect(recallConfidence(20, 1)).toBe("medium");
		expect(recallConfidence(10, 1)).toBe("medium");
		expect(recallConfidence(9, 1)).toBe("low");
		expect(recallConfidence(20, 0)).toBe("low");
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
			USER_PROFILE_PATH,
			"# USER.md\n\n## Profile\nRuns Acme proposal work.\n\n## Preferences\n_No durable facts recorded yet._\n\n## Environment\n_No durable facts recorded yet._\n\n## Constraints\n_No durable facts recorded yet._\n\n## Open Questions\n_No durable facts recorded yet._\n",
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

	test("caps memory note snippets during collection", async () => {
		const backend = createBackend("recall-memory-snippet-cap");
		await ensureMemoryBootstrapped(backend);
		await upsertIndexFile(backend, MEMORY_INDEX_PATH, {
			slug: "large-note",
			path: "/memory/notes/large-note.md",
			hook: "Large note",
		});
		await overwrite(backend, "/memory/notes/large-note.md", "A".repeat(3000));

		const candidates = await memoryRecallCandidates(backend);
		const note = candidates.find(
			(candidate) => candidate.id === "memory:large-note",
		);

		expect(note?.snippet?.length).toBeLessThanOrEqual(1200);
		expect(note?.snippet).toEndWith("...");
	});

	test("skips unsafe memory index paths during recall", async () => {
		const backend = createBackend("recall-safe-memory-paths");
		await ensureMemoryBootstrapped(backend);
		await overwrite(
			backend,
			MEMORY_INDEX_PATH,
			[
				"# MEMORY.md",
				"",
				"## Index",
				"- [good](/memory/notes/good.md): Safe note",
				"- [leak](/secrets/token.md): Secret note",
				"- [traversal](/memory/notes/../secret.md): Traversal note",
			].join("\n"),
		);
		await overwrite(backend, "/memory/notes/good.md", "Safe body");
		await overwrite(backend, "/secrets/token.md", "TOP SECRET");
		await overwrite(backend, "/memory/notes/../secret.md", "TRAVERSAL SECRET");

		const candidates = await memoryRecallCandidates(backend);

		expect(candidates.map((candidate) => candidate.id)).toContain(
			"memory:good",
		);
		expect(candidates.map((candidate) => candidate.id)).not.toContain(
			"memory:leak",
		);
		expect(candidates.map((candidate) => candidate.id)).not.toContain(
			"memory:traversal",
		);
		expect(
			candidates.some((candidate) =>
				(candidate.snippet ?? "").includes("SECRET"),
			),
		).toBe(false);
	});

	test("skips empty bootstrapped user profile candidates", async () => {
		const backend = createBackend("recall-empty-profile");
		await ensureMemoryBootstrapped(backend);

		const candidates = await memoryRecallCandidates(backend);

		expect(candidates.map((candidate) => candidate.id)).not.toContain(
			"memory:user-profile",
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
		await upsertIndexFile(backend, MEMORY_INDEX_PATH, {
			slug: "sales-proposal",
			path: "/memory/notes/sales-proposal.md",
			hook: "Sales proposal context",
		});
		await overwrite(
			backend,
			"/memory/notes/sales-proposal.md",
			"Proposal memory note",
		);
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

	test("keeps available recall candidates when one source fails", async () => {
		const result = await collectRecallCandidates({
			userId: "telegram:1",
			taskStore: {
				listActiveTasks: async () => {
					throw new Error("task store unavailable");
				},
			},
			checkpointStore: {
				listRecentForCaller: async () => [
					makeCheckpoint({ id: "checkpoint-ok" }),
				],
			},
		});

		expect(result).toEqual([
			expect.objectContaining({
				id: "checkpoint:checkpoint-ok",
				source: "checkpoint",
			}),
		]);
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
		expect(context).not.toContain("Use the March pricing notes");
		expect(context).toContain("High confidence: proceed");
		expect(context).toContain("untrusted evidence");
	});

	test("formats targeted clarification fallback when recall has no evidence", () => {
		const ranked = rankRecallCandidates({
			input: "what we discussed",
			candidates: [],
			now: NOW,
		});

		const context = formatRecallRuntimeContext(ranked);

		expect(context).toContain("## Recall-on-Ambiguity");
		expect(context).toContain(
			"Recall search found no source-backed candidates",
		);
		expect(context).toContain("Ask one targeted clarification");
		expect(context).toContain("do not invent missing context");
		expect(context).not.toContain("Candidates:");
	});
});
