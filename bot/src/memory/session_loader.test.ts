import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import { ensureMemoryBootstrapped } from "./bootstrap";
import { overwrite } from "./fs";
import { upsertIndexFile } from "./index_manager";
import {
	MEMORY_INDEX_PATH,
	MEMORY_PROMPT_CHAR_CAP,
	USER_PROFILE_PATH,
} from "./layout";
import { buildSystemPrompt, composeMemorySnapshot } from "./session_loader";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

describe("composeMemorySnapshot", () => {
	test("joins MEMORY / USER / SKILLS under Current memory header", async () => {
		const backend = createBackend("snap-basic");
		await ensureMemoryBootstrapped(backend);
		await overwrite(
			backend,
			USER_PROFILE_PATH,
			"# USER.md\n\n## Profile\n_No durable facts recorded yet._\n\n## Preferences\nTerse replies preferred.\n\n## Environment\n_No durable facts recorded yet._\n\n## Constraints\n_No durable facts recorded yet._\n\n## Open Questions\n_No durable facts recorded yet._\n",
		);
		const snapshot = await composeMemorySnapshot(backend);
		expect(snapshot).toContain("## Current memory");
		expect(snapshot).toContain("Terse replies preferred.");
	});

	test("truncates oversized snapshot and includes truncation marker", async () => {
		const backend = createBackend("snap-truncate");
		await ensureMemoryBootstrapped(backend);
		const bloat = "x".repeat(MEMORY_PROMPT_CHAR_CAP * 2);
		await overwrite(backend, MEMORY_INDEX_PATH, bloat);
		const snapshot = await composeMemorySnapshot(backend);
		expect(snapshot.length).toBeLessThanOrEqual(MEMORY_PROMPT_CHAR_CAP);
		expect(snapshot).toContain("truncated");
	});
});

describe("buildSystemPrompt", () => {
	test("composes identity + memory rules + snapshot", async () => {
		const backend = createBackend("prompt-compose");
		await ensureMemoryBootstrapped(backend);
		const prompt = await buildSystemPrompt({
			identityPrompt: "# Test Identity\n\nBe helpful.",
			backend,
		});
		expect(prompt).toContain("# Test Identity");
		expect(prompt).toContain("## Current memory");
		// Separator between sections.
		expect(prompt.split("---").length).toBeGreaterThanOrEqual(3);
	});

	test("includes recall-on-ambiguity behavior in memory rules", async () => {
		const backend = createBackend("prompt-recall-rules");
		await ensureMemoryBootstrapped(backend);
		const prompt = await buildSystemPrompt({
			identityPrompt: "# Identity",
			backend,
		});

		expect(prompt).toContain("ambiguous continuation");
		expect(prompt).toMatch(/search available\s+internal context/);
		expect(prompt).toContain("active tasks");
		expect(prompt).toContain("recent compacted/checkpoint context");
		expect(prompt).toContain("For high-confidence recall");
		expect(prompt).toContain("For medium confidence");
		expect(prompt).toContain("For low confidence");
		expect(prompt).toContain("ask one targeted clarification");
		expect(prompt).toContain("Do not treat a recalled candidate as");
		expect(prompt).toContain("Keep the user-facing recall wording concise");
	});

	test("appends ## Memory maintenance block when lint finds issues", async () => {
		const backend = createBackend("prompt-maint");
		await ensureMemoryBootstrapped(backend);
		// Create an orphan.
		await overwrite(
			backend,
			"/memory/notes/orphan.md",
			"# Orphan\n\n## Actuel\n_Not in index_\n",
		);
		const prompt = await buildSystemPrompt({
			identityPrompt: "# Identity",
			backend,
		});
		expect(prompt).toMatch(/\n## Memory maintenance\n- /);
		expect(prompt).toContain("/memory/notes/orphan.md");
	});

	test("omits maintenance block when workspace is clean", async () => {
		const backend = createBackend("prompt-clean");
		await ensureMemoryBootstrapped(backend);
		await upsertIndexFile(backend, MEMORY_INDEX_PATH, {
			slug: "alpha",
			path: "/memory/notes/alpha.md",
			hook: "a",
		});
		await overwrite(
			backend,
			"/memory/notes/alpha.md",
			"# Alpha\n\n## Actuel\nOK\n",
		);
		// USER.md must be populated or lint will emit the empty-profile note.
		await overwrite(
			backend,
			"/memory/USER.md",
			"# USER.md\n\n## Profile\nRole: staff eng.\n\n## Preferences\nPrefers terse replies.\n\n## Environment\nTimezone: Asia/Bangkok.\n\n## Constraints\n_No durable facts recorded yet._\n\n## Open Questions\n_No durable facts recorded yet._\n",
		);
		const prompt = await buildSystemPrompt({
			identityPrompt: "# Identity",
			backend,
		});
		// The lint-emitted block is a standalone heading followed by a bullet;
		// the memory-rules markdown also references the phrase in backticks, so
		// we look for the actual block shape, not a bare substring.
		expect(prompt).not.toMatch(/\n## Memory maintenance\n- /);
	});

	test("appends runtime-only compaction context when provided", async () => {
		const backend = createBackend("prompt-runtime-context");
		await ensureMemoryBootstrapped(backend);
		const prompt = await buildSystemPrompt({
			identityPrompt: "# Identity",
			backend,
			runtimeContextBlock: "## Compacted Conversation Context\n\n{}",
		});
		expect(prompt).toContain("## Compacted Conversation Context");
	});

	test("appends one-turn recall context when provided", async () => {
		const backend = createBackend("prompt-recall-runtime-context");
		await ensureMemoryBootstrapped(backend);
		const prompt = await buildSystemPrompt({
			identityPrompt: "# Identity",
			backend,
			runtimeContextBlock:
				"## Recall-on-Ambiguity\nHigh confidence: proceed with a brief source mention. Medium confidence: ask confirmation. Low confidence: offer likely candidates or ask one targeted clarification.",
		});

		expect(prompt).toContain("## Recall-on-Ambiguity");
		expect(prompt).toContain("High confidence: proceed");
		expect(prompt).toContain("Medium confidence: ask confirmation");
		expect(prompt).toContain("Low confidence: offer likely candidates");
	});

	test("appends active-task snapshot when provided", async () => {
		const backend = createBackend("prompt-active-tasks");
		await ensureMemoryBootstrapped(backend);
		const prompt = await buildSystemPrompt({
			identityPrompt: "# Identity",
			backend,
			activeTaskSnapshot:
				"## Active tasks\n- [12] today: Ship task tools\n- [9] backlog: Follow up",
		});
		expect(prompt).toContain("## Active tasks");
		expect(prompt).toContain("today: Ship task tools");
	});
});
