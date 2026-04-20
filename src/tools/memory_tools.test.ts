import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import { ensureMemoryBootstrapped } from "../memory/bootstrap";
import { readOrEmpty } from "../memory/fs";
import {
	MEMORY_INDEX_PATH,
	MEMORY_LOG_PATH,
	SKILLS_INDEX_PATH,
} from "../memory/layout";
import {
	createMemoryAppendLogTool,
	createMemoryWriteTool,
	createSkillWriteTool,
} from "./memory_tools";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

type Invokable = { invoke: (input: unknown) => Promise<string> };

async function callTool(tool: unknown, input: unknown): Promise<string> {
	return (tool as Invokable).invoke(input);
}

describe("memory_write", () => {
	test("creates note, updates MEMORY.md, returns updated index excerpt", async () => {
		const backend = createBackend("mw-create");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryWriteTool(backend);

		const result = await callTool(tool, {
			topic: "user preferences",
			content: "Terse replies. Prefers TypeScript.",
			hook: "known prefs",
		});

		expect(result).toContain("/memory/notes/user-preferences.md");
		expect(result).toContain("Updated MEMORY.md");

		const noteContent = await readOrEmpty(
			backend,
			"/memory/notes/user-preferences.md",
		);
		expect(noteContent).toContain("# user preferences");
		expect(noteContent).toContain("## Actuel");
		expect(noteContent).toContain("Terse replies.");

		const index = await readOrEmpty(backend, MEMORY_INDEX_PATH);
		expect(index).toContain(
			"- [user-preferences](/memory/notes/user-preferences.md): known prefs",
		);
	});

	test("defaults hook to topic when omitted", async () => {
		const backend = createBackend("mw-default-hook");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryWriteTool(backend);

		await callTool(tool, { topic: "alpha", content: "body" });

		const index = await readOrEmpty(backend, MEMORY_INDEX_PATH);
		expect(index).toContain("- [alpha](/memory/notes/alpha.md): alpha");
	});

	test("rotate_actuel mode moves old Actuel into Archive", async () => {
		const backend = createBackend("mw-rotate");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryWriteTool(backend);

		await callTool(tool, { topic: "facts", content: "v1 body" });
		await callTool(tool, {
			topic: "facts",
			content: "v2 body",
			mode: "rotate_actuel",
		});

		const note = await readOrEmpty(backend, "/memory/notes/facts.md");
		expect(note).toContain("v2 body");
		expect(note).toContain("## Archive");
		expect(note).toContain("v1 body");
	});

	test("replace mode (default) overwrites without archiving", async () => {
		const backend = createBackend("mw-replace");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryWriteTool(backend);

		await callTool(tool, { topic: "facts", content: "v1 body" });
		await callTool(tool, { topic: "facts", content: "v2 body" });

		const note = await readOrEmpty(backend, "/memory/notes/facts.md");
		expect(note).toContain("v2 body");
		expect(note).not.toContain("v1 body");
		expect(note).not.toContain("## Archive");
	});
});

describe("skill_write", () => {
	test("creates skill, updates SKILLS.md, returns updated index excerpt", async () => {
		const backend = createBackend("sw-create");
		await ensureMemoryBootstrapped(backend);
		const tool = createSkillWriteTool(backend);

		const result = await callTool(tool, {
			name: "deploy rollback",
			content: "1. revert commit\n2. redeploy",
			hook: "revert + redeploy",
		});

		expect(result).toContain("/skills/deploy-rollback.md");
		expect(result).toContain("Updated SKILLS.md");

		const skill = await readOrEmpty(backend, "/skills/deploy-rollback.md");
		expect(skill).toContain("# deploy rollback");
		expect(skill).toContain("1. revert commit");

		const index = await readOrEmpty(backend, SKILLS_INDEX_PATH);
		expect(index).toContain(
			"- [deploy-rollback](/skills/deploy-rollback.md): revert + redeploy",
		);
	});
});

describe("memory_append_log", () => {
	test("appends entry and reports logged line", async () => {
		const backend = createBackend("log-tool");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryAppendLogTool(backend);

		const result = await callTool(tool, {
			op: "preference_learned",
			detail: "user likes TS",
		});

		expect(result).toContain("Logged:");
		expect(result).toContain("preference_learned");

		const log = await readOrEmpty(backend, MEMORY_LOG_PATH);
		expect(log).toContain("preference_learned | user likes TS");
	});
});
