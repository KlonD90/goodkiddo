import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import { ensureMemoryBootstrapped } from "./bootstrap";
import { overwrite } from "./fs";
import { upsertIndexFile } from "./index_manager";
import { MEMORY_INDEX_PATH, MEMORY_PROMPT_CHAR_CAP, USER_PROFILE_PATH } from "./layout";
import {
	formatMaintenanceBlock,
	isEmpty,
	type LintFindings,
	runLint,
} from "./lint";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

function findings(overrides: Partial<LintFindings> = {}): LintFindings {
	return {
		staleNotes: [],
		orphans: [],
		duplicates: [],
		malformedIndexLines: [],
		emptySlugPaths: [],
		missingActuelPaths: [],
		overBudget: null,
		userProfileEmpty: false,
		userProfileUnstructured: false,
		...overrides,
	};
}

describe("runLint", () => {
	test("fresh workspace flags only userProfileEmpty — nothing else to maintain", async () => {
		const backend = createBackend("lint-fresh");
		await ensureMemoryBootstrapped(backend);
		const findings = await runLint(backend);
		expect(findings.userProfileEmpty).toBe(true);
		expect(findings.staleNotes).toEqual([]);
		expect(findings.orphans).toEqual([]);
		expect(findings.duplicates).toEqual([]);
		expect(findings.malformedIndexLines).toEqual([]);
		expect(findings.emptySlugPaths).toEqual([]);
		expect(findings.missingActuelPaths).toEqual([]);
		expect(findings.overBudget).toBeNull();
		expect(isEmpty(findings)).toBe(false);
	});

	test("populated USER.md clears the empty-profile flag", async () => {
		const backend = createBackend("lint-profile-populated");
		await ensureMemoryBootstrapped(backend);
		await overwrite(
			backend,
			"/memory/USER.md",
			"# USER.md\n\n## Profile\nRole: staff eng.\n\n## Preferences\nPrefers terse replies.\n\n## Environment\nTimezone: Asia/Bangkok.\n\n## Constraints\n_No durable facts recorded yet._\n\n## Open Questions\n_No durable facts recorded yet._\n",
		);
		const findings = await runLint(backend);
		expect(findings.userProfileEmpty).toBe(false);
		expect(findings.userProfileUnstructured).toBe(false);
	});

	test("flags legacy unstructured USER.md without treating it as empty", async () => {
		const backend = createBackend("lint-profile-legacy");
		await ensureMemoryBootstrapped(backend);
		await overwrite(
			backend,
			"/memory/USER.md",
			"# USER.md\n\n## Actuel\nRole: staff eng. Prefers terse replies.\n",
		);

		const findings = await runLint(backend);
		expect(findings.userProfileEmpty).toBe(false);
		expect(findings.userProfileUnstructured).toBe(true);
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

	test("flags over-budget when USER_PROFILE_PATH alone exceeds cap", async () => {
		const backend = createBackend("lint-budget-user");
		await ensureMemoryBootstrapped(backend);
		// USER_PROFILE_PATH is now included in overBudget calculation
		const bloat = "x".repeat(Math.ceil(MEMORY_PROMPT_CHAR_CAP * 1.5));
		await overwrite(backend, USER_PROFILE_PATH, bloat);

		const findings = await runLint(backend);
		expect(findings.overBudget).not.toBeNull();
	});

	test("flags malformed index lines", async () => {
		const backend = createBackend("lint-malformed-index");
		await ensureMemoryBootstrapped(backend);
		await overwrite(
			backend,
			MEMORY_INDEX_PATH,
			"# MEMORY.md\n\n## Index\n- [good](/memory/notes/good.md): ok\n- malformed entry\n",
		);

		const findings = await runLint(backend);
		expect(findings.malformedIndexLines).toEqual([
			"/memory/MEMORY.md: - malformed entry",
		]);
	});

	test("flags empty-slug paths", async () => {
		const backend = createBackend("lint-empty-slug");
		await ensureMemoryBootstrapped(backend);
		await overwrite(backend, "/memory/notes/.md", "# Empty\n\n## Actuel\nBad.\n");

		const findings = await runLint(backend);
		expect(findings.emptySlugPaths).toContain("/memory/notes/.md");
	});

	test("flags note and skill files missing Actuel", async () => {
		const backend = createBackend("lint-missing-actuel");
		await ensureMemoryBootstrapped(backend);
		await overwrite(backend, "/memory/notes/raw.md", "# Raw\n\nNo Actuel.\n");

		const findings = await runLint(backend);
		expect(findings.missingActuelPaths).toContain("/memory/notes/raw.md");
	});
});

describe("formatMaintenanceBlock", () => {
	test("returns empty string when findings are empty", () => {
		const block = formatMaintenanceBlock(findings());
		expect(block).toBe("");
	});

	test("lists orphans in the maintenance block", () => {
		const block = formatMaintenanceBlock(findings({
			orphans: ["/memory/notes/a.md"],
		}));
		expect(block).toContain("## Memory maintenance");
		expect(block).toContain("/memory/notes/a.md");
		expect(block).toContain("orphan");
	});

	test("mentions over-budget with char counts", () => {
		const block = formatMaintenanceBlock(findings({
			overBudget: { memoryChars: 9999, skillsChars: 0 },
		}));
		expect(block).toContain("9999");
		expect(block).toContain("budget");
	});

	test("truncates long lists with +N more marker", () => {
		const many = Array.from({ length: 8 }, (_, i) => `/memory/notes/n${i}.md`);
		const block = formatMaintenanceBlock(findings({
			orphans: many,
		}));
		expect(block).toContain("+3 more");
	});

	test("softens the empty USER.md maintenance wording", () => {
		const block = formatMaintenanceBlock(findings({ userProfileEmpty: true }));
		expect(block).toContain("Continue with the user request");
		expect(block).not.toContain("Before doing other work");
	});
});

describe("exempt markers (.archived / .permanent)", () => {
	test("stale .archived file is NOT flagged as stale", async () => {
		const backend = createBackend("lint-exempt-archived-stale");
		await ensureMemoryBootstrapped(backend);
		// Write a note directly (bypass index) so it looks like a legacy file
		await overwrite(
			backend,
			"/memory/notes/old.archived",
			"# Old\n\n## Actuel\nLegacy content.\n",
		);

		const findings = await runLint(backend);
		// The file has no index entry so it's an orphan — but it should NOT
		// appear in staleNotes even if we later add it to the index
		expect(findings.staleNotes).not.toContain("/memory/notes/old.archived");
	});

	test("stale .permanent file is NOT flagged as stale", async () => {
		const backend = createBackend("lint-exempt-permanent-stale");
		await ensureMemoryBootstrapped(backend);
		await overwrite(
			backend,
			"/memory/notes/ref.permanent",
			"# Ref\n\n## Actuel\nReference.\n",
		);

		const findings = await runLint(backend);
		expect(findings.staleNotes).not.toContain("/memory/notes/ref.permanent");
	});

	test(".archived file is NOT flagged as orphan", async () => {
		const backend = createBackend("lint-exempt-archived-orphan");
		await ensureMemoryBootstrapped(backend);
		// Create a .archived file not in the index — should NOT be flagged orphan
		await overwrite(
			backend,
			"/memory/notes/dead.archived",
			"# Dead\n\n## Actuel\nArchived.\n",
		);

		const findings = await runLint(backend);
		expect(findings.orphans).not.toContain("/memory/notes/dead.archived");
	});

	test(".archived empty-slug file is NOT flagged as empty-slug", async () => {
		const backend = createBackend("lint-exempt-archived-slug");
		await ensureMemoryBootstrapped(backend);
		await overwrite(backend, "/memory/notes/.archived", "# Empty\n\n## Actuel\nBad.\n");

		const findings = await runLint(backend);
		expect(findings.emptySlugPaths).not.toContain("/memory/notes/.archived");
	});
});
