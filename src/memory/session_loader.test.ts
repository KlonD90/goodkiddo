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
			"# USER.md\n\n## Actuel\nTerse replies preferred.\n",
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
		const prompt = await buildSystemPrompt({
			identityPrompt: "# Identity",
			backend,
		});
		// The lint-emitted block is a standalone heading followed by a bullet;
		// the memory-rules markdown also references the phrase in backticks, so
		// we look for the actual block shape, not a bare substring.
		expect(prompt).not.toMatch(/\n## Memory maintenance\n- /);
	});
});
