import { beforeEach, describe, expect, test } from "bun:test";
import { maybeHandleCommand } from "./commands";
import { PermissionsStore } from "./store";
import type { Caller } from "./types";

let store: PermissionsStore;
const caller: Caller = {
	id: "telegram:1",
	entrypoint: "telegram",
	externalId: "1",
};

beforeEach(() => {
	store = new PermissionsStore({ dbPath: ":memory:" });
	store.upsertUser({ entrypoint: "telegram", externalId: "1" });
});

describe("maybeHandleCommand", () => {
	test("non-slash input is ignored", () => {
		expect(maybeHandleCommand("hello", caller, store)).toEqual({
			handled: false,
		});
	});

	test("/policy on empty store explains default", () => {
		const result = maybeHandleCommand("/policy", caller, store);
		expect(result.handled).toBe(true);
		if (result.handled) expect(result.reply).toMatch(/No policy/);
	});

	test("/allow then /policy reflects rule", () => {
		expect(maybeHandleCommand("/allow write_file", caller, store).handled).toBe(
			true,
		);
		const list = store.listRulesForUser(caller.id);
		expect(list).toHaveLength(1);
		expect(list[0].decision).toBe("allow");
	});

	test("/deny with --args parses matcher", () => {
		const result = maybeHandleCommand(
			'/deny write_file --args {"file_path":{"glob":"secret/**"}}',
			caller,
			store,
		);
		expect(result.handled).toBe(true);
		const rules = store.listRulesForUser(caller.id);
		expect(rules[0].args).toEqual({ file_path: { glob: "secret/**" } });
		expect(rules[0].decision).toBe("deny");
	});

	test("/ask removes a matching rule", () => {
		store.upsertRule(caller.id, {
			priority: 100,
			toolName: "write_file",
			args: null,
			decision: "deny",
		});
		const result = maybeHandleCommand("/ask write_file", caller, store);
		expect(result.handled).toBe(true);
		expect(store.listRulesForUser(caller.id)).toHaveLength(0);
	});

	test("/reset clears all rules", () => {
		store.upsertRule(caller.id, {
			priority: 100,
			toolName: "*",
			args: null,
			decision: "allow",
		});
		expect(maybeHandleCommand("/reset", caller, store).handled).toBe(true);
		expect(store.listRulesForUser(caller.id)).toHaveLength(0);
	});

	test("/help is recognized", () => {
		const result = maybeHandleCommand("/help", caller, store);
		expect(result.handled).toBe(true);
	});

	test("telegram-style commands with bot username suffix are recognized", () => {
		const result = maybeHandleCommand("/policy@top_fedder_bot", caller, store);
		expect(result.handled).toBe(true);
		if (result.handled) expect(result.reply).toMatch(/No policy/);
	});
});
