import { beforeEach, describe, expect, test } from "bun:test";
import { PermissionsStore } from "./store";

let store: PermissionsStore;

beforeEach(() => {
	store = new PermissionsStore({ dbPath: ":memory:" });
});

describe("PermissionsStore", () => {
	test("getUser returns null for unknown sender", () => {
		expect(store.getUser("telegram", "999")).toBeNull();
	});

	test("upsertUser then getUser round-trip", () => {
		const created = store.upsertUser({
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Alice",
		});
		expect(created.id).toBe("telegram:123");
		const fetched = store.getUser("telegram", "123");
		expect(fetched?.displayName).toBe("Alice");
		expect(fetched?.status).toBe("active");
	});

	test("upsertRule deduplicates on (tool, args)", () => {
		store.upsertUser({ entrypoint: "telegram", externalId: "1" });
		store.upsertRule("telegram:1", {
			priority: 100,
			toolName: "write_file",
			args: null,
			decision: "ask",
		});
		store.upsertRule("telegram:1", {
			priority: 50,
			toolName: "write_file",
			args: null,
			decision: "allow",
		});
		const rules = store.listRulesForUser("telegram:1");
		expect(rules).toHaveLength(1);
		expect(rules[0].decision).toBe("allow");
		expect(rules[0].priority).toBe(50);
	});

	test("upsertRule keeps args-distinct rules separate", () => {
		store.upsertUser({ entrypoint: "telegram", externalId: "1" });
		store.upsertRule("telegram:1", {
			priority: 10,
			toolName: "write_file",
			args: { file_path: { glob: "drafts/**" } },
			decision: "allow",
		});
		store.upsertRule("telegram:1", {
			priority: 100,
			toolName: "write_file",
			args: null,
			decision: "deny",
		});
		expect(store.listRulesForUser("telegram:1")).toHaveLength(2);
	});

	test("deleteMatchingRules and deleteAllRulesForUser", () => {
		store.upsertUser({ entrypoint: "cli", externalId: "u" });
		store.upsertRule("cli:u", {
			priority: 100,
			toolName: "ls",
			args: null,
			decision: "allow",
		});
		store.upsertRule("cli:u", {
			priority: 100,
			toolName: "write_file",
			args: null,
			decision: "deny",
		});
		expect(store.deleteMatchingRules("cli:u", "ls", null)).toBe(1);
		expect(store.listRulesForUser("cli:u")).toHaveLength(1);
		expect(store.deleteAllRulesForUser("cli:u")).toBe(1);
		expect(store.listRulesForUser("cli:u")).toHaveLength(0);
	});

	test("setUserStatus suspends and reactivates", () => {
		store.upsertUser({ entrypoint: "telegram", externalId: "5" });
		store.setUserStatus("telegram:5", "suspended");
		expect(store.getUser("telegram", "5")?.status).toBe("suspended");
		store.setUserStatus("telegram:5", "active");
		expect(store.getUser("telegram", "5")?.status).toBe("active");
	});
});
