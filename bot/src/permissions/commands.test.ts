import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { maybeHandleCommand } from "./commands";
import { PermissionsStore } from "./store";
import type { Caller } from "./types";

let db: InstanceType<typeof Bun.SQL>;
let store: PermissionsStore;
const caller: Caller = {
	id: "telegram:1",
	entrypoint: "telegram",
	externalId: "1",
};

beforeEach(async () => {
	db = new Bun.SQL("sqlite://:memory:");
	store = new PermissionsStore({ db, dialect: "sqlite" });
	await store.upsertUser({ entrypoint: "telegram", externalId: "1" });
});

afterEach(async () => {
	await db.close();
});

describe("maybeHandleCommand", () => {
	test("non-slash input is ignored", async () => {
		expect(await maybeHandleCommand("hello", caller, store)).toEqual({
			handled: false,
		});
	});

	test("/policy on empty store explains default", async () => {
		const result = await maybeHandleCommand("/policy", caller, store);
		expect(result.handled).toBe(true);
		if (result.handled) expect(result.reply).toMatch(/No policy/);
	});

	test("/allow then /policy reflects rule", async () => {
		expect(
			(await maybeHandleCommand("/allow write_file", caller, store)).handled,
		).toBe(true);
		const list = await store.listRulesForUser(caller.id);
		expect(list).toHaveLength(1);
		expect(list[0].decision).toBe("allow");
	});

	test("/deny with --args parses matcher", async () => {
		const result = await maybeHandleCommand(
			'/deny write_file --args {"file_path":{"glob":"secret/**"}}',
			caller,
			store,
		);
		expect(result.handled).toBe(true);
		const rules = await store.listRulesForUser(caller.id);
		expect(rules[0].args).toEqual({ file_path: { glob: "secret/**" } });
		expect(rules[0].decision).toBe("deny");
	});

	test("/ask removes a matching rule", async () => {
		await store.upsertRule(caller.id, {
			priority: 100,
			toolName: "write_file",
			args: null,
			decision: "deny",
		});
		const result = await maybeHandleCommand("/ask write_file", caller, store);
		expect(result.handled).toBe(true);
		expect(await store.listRulesForUser(caller.id)).toHaveLength(0);
	});

	test("/reset clears all rules", async () => {
		await store.upsertRule(caller.id, {
			priority: 100,
			toolName: "*",
			args: null,
			decision: "allow",
		});
		expect((await maybeHandleCommand("/reset", caller, store)).handled).toBe(
			true,
		);
		expect(await store.listRulesForUser(caller.id)).toHaveLength(0);
	});

	test("/help is recognized", async () => {
		const result = await maybeHandleCommand("/help", caller, store);
		expect(result.handled).toBe(true);
	});

	test("telegram-style commands with bot username suffix are recognized", async () => {
		const result = await maybeHandleCommand(
			"/policy@top_fedder_bot",
			caller,
			store,
		);
		expect(result.handled).toBe(true);
		if (result.handled) expect(result.reply).toMatch(/No policy/);
	});
});
