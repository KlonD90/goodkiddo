import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import { ensureMemoryBootstrapped } from "../memory/bootstrap";
import { overwrite, readOrEmpty } from "../memory/fs";
import {
	MEMORY_INDEX_PATH,
	MEMORY_LOG_PATH,
	SKILLS_INDEX_PATH,
	USER_PROFILE_PATH,
} from "../memory/layout";
import {
	createMemoryAppendLogTool,
	createMemoryMaintainTool,
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

	test("concurrent writes to distinct topics all land in the index", async () => {
		const backend = createBackend("mw-concurrent");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryWriteTool(backend);

		const topics = Array.from({ length: 10 }, (_, i) => `topic-${i}`);
		await Promise.all(
			topics.map((topic) =>
				callTool(tool, { topic, content: `body for ${topic}` }),
			),
		);

		const index = await readOrEmpty(backend, MEMORY_INDEX_PATH);
		for (const topic of topics) {
			expect(index).toContain(`- [${topic}](/memory/notes/${topic}.md)`);
		}
	});

	test("target: 'user' writes USER.md without touching MEMORY.md index", async () => {
		const backend = createBackend("mw-user-target");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryWriteTool(backend);

		const indexBefore = await readOrEmpty(backend, MEMORY_INDEX_PATH);
		const result = await callTool(tool, {
			target: "user",
			content: "Role: staff eng. Goal: ship top-fedder. Prefers terse replies.",
		});

		expect(result).toContain("USER.md");
		const user = await readOrEmpty(backend, USER_PROFILE_PATH);
		expect(user).toContain("# USER.md");
		expect(user).toContain("## Profile");
		expect(user).toContain("## Preferences");
		expect(user).toContain("## Environment");
		expect(user).toContain("## Constraints");
		expect(user).toContain("## Open Questions");
		expect(user).toContain("Role: staff eng.");

		const indexAfter = await readOrEmpty(backend, MEMORY_INDEX_PATH);
		expect(indexAfter).toBe(indexBefore);
	});

	test("target: 'user' notifies prompt-injected memory mutation callback", async () => {
		const backend = createBackend("mw-user-callback");
		await ensureMemoryBootstrapped(backend);
		const mutations: string[] = [];
		const tool = createMemoryWriteTool(backend, (kind) => {
			mutations.push(kind);
		});

		await callTool(tool, {
			target: "user",
			content: "Timezone: Asia/Bangkok.",
		});

		expect(mutations).toEqual(["user"]);
	});

	test("target: 'notes' notifies prompt-injected memory mutation callback", async () => {
		const backend = createBackend("mw-notes-callback");
		await ensureMemoryBootstrapped(backend);
		const mutations: string[] = [];
		const tool = createMemoryWriteTool(backend, (kind) => {
			mutations.push(kind);
		});

		await callTool(tool, {
			topic: "project",
			content: "Stable fact.",
		});

		expect(mutations).toEqual(["notes"]);
	});

	test("target: 'user' normalizes structured sections", async () => {
		const backend = createBackend("mw-user-rotate");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryWriteTool(backend);

		await callTool(tool, {
			target: "user",
			content: [
				"# USER.md",
				"",
				"## Preferences",
				"Prefers terse replies.",
				"",
				"## Environment",
				"Timezone: Asia/Bangkok.",
			].join("\n"),
		});

		const user = await readOrEmpty(backend, USER_PROFILE_PATH);
		expect(user).toContain("## Profile");
		expect(user).toContain("## Preferences");
		expect(user).toContain("Prefers terse replies.");
		expect(user).toContain("## Environment");
		expect(user).toContain("Timezone: Asia/Bangkok.");
		expect(user).toContain("## Constraints");
		expect(user).toContain("## Open Questions");
	});

	test("target: 'notes' without topic returns an error", async () => {
		const backend = createBackend("mw-notes-no-topic");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryWriteTool(backend);

		const result = await callTool(tool, { content: "orphan body" });
		expect(result.toLowerCase()).toContain("error");
		expect(result).toContain("topic");
	});

	test("target: 'notes' rejects topics that cannot form a safe slug", async () => {
		const backend = createBackend("mw-notes-empty-slug");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryWriteTool(backend);

		const result = await callTool(tool, {
			topic: "!!!",
			content: "body",
		});

		expect(result).toContain("Error:");
		expect(result).toContain("topic");
		expect(await readOrEmpty(backend, "/memory/notes/.md")).toBe("");
	});

	test("normalizes multiline hooks before writing MEMORY.md", async () => {
		const backend = createBackend("mw-hook-normalize");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryWriteTool(backend);

		await callTool(tool, {
			topic: "safe topic",
			content: "body",
			hook: "first line\n- [evil](/memory/notes/evil.md): injected",
		});

		const index = await readOrEmpty(backend, MEMORY_INDEX_PATH);
		expect(index).toContain(
			"- [safe-topic](/memory/notes/safe-topic.md): first line - [evil](/memory/notes/evil.md): injected",
		);
		expect(index).not.toContain("\n- [evil]");
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

	test("notifies prompt-injected memory mutation callback", async () => {
		const backend = createBackend("sw-callback");
		await ensureMemoryBootstrapped(backend);
		const mutations: string[] = [];
		const tool = createSkillWriteTool(backend, (kind) => {
			mutations.push(kind);
		});

		await callTool(tool, {
			name: "deploy rollback",
			content: "1. revert commit\n2. redeploy",
		});

		expect(mutations).toEqual(["skills"]);
	});

	test("rejects names that cannot form a safe slug", async () => {
		const backend = createBackend("sw-empty-slug");
		await ensureMemoryBootstrapped(backend);
		const tool = createSkillWriteTool(backend);

		const result = await callTool(tool, {
			name: "!!!",
			content: "steps",
		});

		expect(result).toContain("Error:");
		expect(result).toContain("name");
		expect(await readOrEmpty(backend, "/skills/.md")).toBe("");
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

describe("memory_maintain", () => {
	test("touch resets mtime of an existing file", async () => {
		const backend = createBackend("mm-touch");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryMaintainTool(backend);

		await overwrite(backend, "/memory/notes/alpha.md", "# Alpha\n\n## Actuel\nInitial.\n");

		const result = await callTool(tool, {
			action: "touch",
			path: "/memory/notes/alpha.md",
		});

		expect(result).toContain("Touched");
		expect(result).toContain("/memory/notes/alpha.md");
		const content = await readOrEmpty(backend, "/memory/notes/alpha.md");
		expect(content).toContain("Initial.");
	});

	test("touch returns error for non-existent file", async () => {
		const backend = createBackend("mm-touch-missing");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryMaintainTool(backend);

		const result = await callTool(tool, {
			action: "touch",
			path: "/memory/notes/does-not-exist.md",
		});

		expect(result).toContain("Error:");
		expect(result).toContain("not found");
	});

	test("touch rejects paths outside allowed roots", async () => {
		const backend = createBackend("mm-touch-bad-path");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryMaintainTool(backend);

		const result = await callTool(tool, {
			action: "touch",
			path: "/etc/passwd",
		});

		expect(result).toContain("Error:");
		expect(result).toContain("/memory/notes/");
	});

	test("archive copies file to .archived and deletes original", async () => {
		const backend = createBackend("mm-archive");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryMaintainTool(backend);

		await overwrite(backend, "/memory/notes/beta.md", "# Beta\n\n## Actuel\nOld content.\n");

		const result = await callTool(tool, {
			action: "archive",
			path: "/memory/notes/beta.md",
		});

		expect(result).toContain("Archived");
		expect(result).toContain(".archived");
		const archived = await readOrEmpty(backend, "/memory/notes/beta.md.archived");
		expect(archived).toContain("Old content.");
		const gone = await readOrEmpty(backend, "/memory/notes/beta.md");
		expect(gone).toBe("");
	});

	test("archive returns error for non-existent file", async () => {
		const backend = createBackend("mm-archive-missing");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryMaintainTool(backend);

		const result = await callTool(tool, {
			action: "archive",
			path: "/memory/notes/nonexistent.md",
		});

		expect(result).toContain("Error:");
		expect(result).toContain("not found");
	});

	test("mark_permanent creates a .permanent companion file", async () => {
		const backend = createBackend("mm-permanent");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryMaintainTool(backend);

		await overwrite(backend, "/memory/notes/gamma.md", "# Gamma\n\n## Actuel\nReference doc.\n");

		const result = await callTool(tool, {
			action: "mark_permanent",
			path: "/memory/notes/gamma.md",
		});

		expect(result).toContain("permanent");
		const marker = await readOrEmpty(backend, "/memory/notes/gamma.md.permanent");
		expect(marker).toBe("");
	});

	test("mark_permanent works on skills files", async () => {
		const backend = createBackend("mm-permanent-skill");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryMaintainTool(backend);

		await overwrite(backend, "/skills/deploy.md", "# deploy\n\n## Steps\n1. deploy\n");

		const result = await callTool(tool, {
			action: "mark_permanent",
			path: "/skills/deploy.md",
		});

		expect(result).toContain("permanent");
		const marker = await readOrEmpty(backend, "/skills/deploy.md.permanent");
		expect(marker).toBe("");
	});

	test("mark_permanent returns error for non-existent file", async () => {
		const backend = createBackend("mm-permanent-missing");
		await ensureMemoryBootstrapped(backend);
		const tool = createMemoryMaintainTool(backend);

		const result = await callTool(tool, {
			action: "mark_permanent",
			path: "/memory/notes/no.md",
		});

		expect(result).toContain("Error:");
		expect(result).toContain("not found");
	});
});
