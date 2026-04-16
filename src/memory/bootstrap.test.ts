import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { ensureMemoryBootstrapped } from "./bootstrap";
import { readOrEmpty } from "./fs";
import {
	MEMORY_INDEX_PATH,
	MEMORY_LOG_PATH,
	SKILLS_INDEX_PATH,
	USER_PROFILE_PATH,
} from "./layout";

function createBackend(namespace: string) {
	return new SqliteStateBackend({ dbPath: ":memory:", namespace });
}

describe("ensureMemoryBootstrapped", () => {
	test("seeds all four canonical files on first run", async () => {
		const backend = createBackend("boot-first");
		await ensureMemoryBootstrapped(backend);

		expect(await readOrEmpty(backend, MEMORY_INDEX_PATH)).toContain("## Index");
		expect(await readOrEmpty(backend, SKILLS_INDEX_PATH)).toContain("## Index");
		expect(await readOrEmpty(backend, USER_PROFILE_PATH)).toContain("# USER.md");
		expect(await readOrEmpty(backend, MEMORY_LOG_PATH)).toContain("# Log");
	});

	test("is idempotent — re-running leaves curated content untouched", async () => {
		const backend = createBackend("boot-idempotent");
		await ensureMemoryBootstrapped(backend);

		// Simulate curated content.
		const encoder = new TextEncoder();
		await backend.uploadFiles([
			[USER_PROFILE_PATH, encoder.encode("# USER.md\n\n## Actuel\nCurated facts.")],
		]);

		await ensureMemoryBootstrapped(backend);

		const after = await readOrEmpty(backend, USER_PROFILE_PATH);
		expect(after).toContain("Curated facts.");
	});

	test("creates fresh MEMORY.md and SKILLS.md with empty-index placeholder", async () => {
		const backend = createBackend("boot-placeholder");
		await ensureMemoryBootstrapped(backend);
		const memory = await readOrEmpty(backend, MEMORY_INDEX_PATH);
		const skills = await readOrEmpty(backend, SKILLS_INDEX_PATH);
		expect(memory).toContain("_No entries yet._");
		expect(skills).toContain("_No entries yet._");
	});
});
