import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import { ensureMemoryBootstrapped } from "./bootstrap";
import { overwrite } from "./fs";
import { upsertIndexFile } from "./index_manager";
import { MEMORY_INDEX_PATH, MEMORY_PROMPT_CHAR_CAP } from "./layout";
import { formatMaintenanceBlock, isEmpty, runLint } from "./lint";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

describe("runLint", () => {
	test("returns empty findings for a fresh workspace", async () => {
		const backend = createBackend("lint-fresh");
		await ensureMemoryBootstrapped(backend);
		const findings = await runLint(backend);
		expect(isEmpty(findings)).toBe(true);
	});

	test("flags notes present on disk but not in the index as orphans", async () => {
		const backend = createBackend("lint-orphan");
		await ensureMemoryBootstrapped(backend);
		await overwrite(
			backend,
			"/memory/notes/lonely.md",
			"# Lonely\n\n## Actuel\nNo index entry.\n",
		);

		const findings = await runLint(backend);
		expect(findings.orphans).toContain("/memory/notes/lonely.md");
	});

	test("does not flag notes that are indexed", async () => {
		const backend = createBackend("lint-indexed");
		await ensureMemoryBootstrapped(backend);
		await overwrite(
			backend,
			"/memory/notes/known.md",
			"# Known\n\n## Actuel\nIn the index.\n",
		);
		await upsertIndexFile(backend, MEMORY_INDEX_PATH, {
			slug: "known",
			path: "/memory/notes/known.md",
			hook: "hook",
		});

		const findings = await runLint(backend);
		expect(findings.orphans).not.toContain("/memory/notes/known.md");
	});

	test("flags over-budget when index files exceed cap × ratio", async () => {
		const backend = createBackend("lint-budget");
		await ensureMemoryBootstrapped(backend);
		const bloat = "x".repeat(Math.ceil(MEMORY_PROMPT_CHAR_CAP * 1.5));
		await overwrite(backend, MEMORY_INDEX_PATH, bloat);

		const findings = await runLint(backend);
		expect(findings.overBudget).not.toBeNull();
	});
});

describe("formatMaintenanceBlock", () => {
	test("returns empty string when findings are empty", () => {
		const block = formatMaintenanceBlock({
			staleNotes: [],
			orphans: [],
			duplicates: [],
			overBudget: null,
		});
		expect(block).toBe("");
	});

	test("lists orphans in the maintenance block", () => {
		const block = formatMaintenanceBlock({
			staleNotes: [],
			orphans: ["/memory/notes/a.md"],
			duplicates: [],
			overBudget: null,
		});
		expect(block).toContain("## Memory maintenance");
		expect(block).toContain("/memory/notes/a.md");
		expect(block).toContain("orphan");
	});

	test("mentions over-budget with char counts", () => {
		const block = formatMaintenanceBlock({
			staleNotes: [],
			orphans: [],
			duplicates: [],
			overBudget: { memoryChars: 9999, skillsChars: 0 },
		});
		expect(block).toContain("9999");
		expect(block).toContain("budget");
	});

	test("truncates long lists with +N more marker", () => {
		const many = Array.from({ length: 8 }, (_, i) => `/memory/notes/n${i}.md`);
		const block = formatMaintenanceBlock({
			staleNotes: [],
			orphans: many,
			duplicates: [],
			overBudget: null,
		});
		expect(block).toContain("+3 more");
	});
});
