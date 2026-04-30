import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import { AccessStore } from "../server/access_store";
import { createGrantFsAccessTool } from "./share_tools";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

describe("createGrantFsAccessTool", () => {
	test("rejects direct prepared follow-up draft file shares", async () => {
		const backend = createBackend("share-internal-draft-file");
		await backend.write("/prepared-followups/d-123.md", "# draft");
		const access = new AccessStore({
			db: createDb("sqlite://:memory:"),
			dialect: "sqlite",
		});
		const tool = createGrantFsAccessTool({
			access,
			workspace: backend,
			callerId: "telegram:12345",
			publicBaseUrl: "http://localhost:8787",
		});

		const result = await tool.invoke({
			scope_path: "/prepared-followups/d-123.md",
		});

		expect(result).toContain("prepared follow-up drafts are internal");
	});

	test("rejects direct prepared follow-up draft directory shares", async () => {
		const backend = createBackend("share-internal-draft-dir");
		await backend.write("/prepared-followups/d-123.md", "# draft");
		const access = new AccessStore({
			db: createDb("sqlite://:memory:"),
			dialect: "sqlite",
		});
		const tool = createGrantFsAccessTool({
			access,
			workspace: backend,
			callerId: "telegram:12345",
			publicBaseUrl: "http://localhost:8787",
		});

		const result = await tool.invoke({
			scope_path: "/prepared-followups/",
		});

		expect(result).toContain("prepared follow-up drafts are internal");
	});
});
