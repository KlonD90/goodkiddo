import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PermissionsStore } from "./store";

let db: InstanceType<typeof Bun.SQL>;
let store: PermissionsStore;

beforeEach(() => {
	db = new Bun.SQL("sqlite://:memory:");
	store = new PermissionsStore({ db, dialect: "sqlite" });
});

afterEach(async () => {
	await db.close();
});

describe("PermissionsStore", () => {
	test("getUser returns null for unknown sender", async () => {
		expect(await store.getUser("telegram", "999")).toBeNull();
	});

	test("upsertUser then getUser round-trip", async () => {
		const created = await store.upsertUser({
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Alice",
		});
		expect(created.id).toBe("telegram:123");
		const fetched = await store.getUser("telegram", "123");
		expect(fetched?.displayName).toBe("Alice");
		expect(fetched?.status).toBe("active");
	});

	test("upsertRule deduplicates on (tool, args)", async () => {
		await store.upsertUser({ entrypoint: "telegram", externalId: "1" });
		await store.upsertRule("telegram:1", {
			priority: 100,
			toolName: "write_file",
			args: null,
			decision: "ask",
		});
		await store.upsertRule("telegram:1", {
			priority: 50,
			toolName: "write_file",
			args: null,
			decision: "allow",
		});
		const rules = await store.listRulesForUser("telegram:1");
		expect(rules).toHaveLength(1);
		expect(rules[0].decision).toBe("allow");
		expect(rules[0].priority).toBe(50);
	});

	test("upsertRule keeps args-distinct rules separate", async () => {
		await store.upsertUser({ entrypoint: "telegram", externalId: "1" });
		await store.upsertRule("telegram:1", {
			priority: 10,
			toolName: "write_file",
			args: { file_path: { glob: "drafts/**" } },
			decision: "allow",
		});
		await store.upsertRule("telegram:1", {
			priority: 100,
			toolName: "write_file",
			args: null,
			decision: "deny",
		});
		expect(await store.listRulesForUser("telegram:1")).toHaveLength(2);
	});

	test("deleteMatchingRules and deleteAllRulesForUser", async () => {
		await store.upsertUser({ entrypoint: "cli", externalId: "u" });
		await store.upsertRule("cli:u", {
			priority: 100,
			toolName: "ls",
			args: null,
			decision: "allow",
		});
		await store.upsertRule("cli:u", {
			priority: 100,
			toolName: "write_file",
			args: null,
			decision: "deny",
		});
		expect(await store.deleteMatchingRules("cli:u", "ls", null)).toBe(1);
		expect(await store.listRulesForUser("cli:u")).toHaveLength(1);
		expect(await store.deleteAllRulesForUser("cli:u")).toBe(1);
		expect(await store.listRulesForUser("cli:u")).toHaveLength(0);
	});

	test("setUserStatus suspends and reactivates", async () => {
		await store.upsertUser({ entrypoint: "telegram", externalId: "5" });
		await store.setUserStatus("telegram:5", "suspended");
		expect((await store.getUser("telegram", "5"))?.status).toBe("suspended");
		await store.setUserStatus("telegram:5", "active");
		expect((await store.getUser("telegram", "5"))?.status).toBe("active");
	});

	test("getUserById returns user by composite id", async () => {
		await store.upsertUser({
			entrypoint: "telegram",
			externalId: "42",
			displayName: "Bob",
		});
		const user = await store.getUserById("telegram:42");
		expect(user?.id).toBe("telegram:42");
		expect(user?.displayName).toBe("Bob");
	});

	test("getUserById returns null for unknown id", async () => {
		expect(await store.getUserById("telegram:999")).toBeNull();
	});

	test("listUsers returns all users in creation order", async () => {
		await store.upsertUser({ entrypoint: "telegram", externalId: "1" });
		await store.upsertUser({ entrypoint: "cli", externalId: "a" });
		const users = await store.listUsers();
		expect(users).toHaveLength(2);
		expect(users[0].id).toBe("telegram:1");
		expect(users[1].id).toBe("cli:a");
	});

	test("ensureUser creates user on first call and returns existing on second", async () => {
		const caller = {
			entrypoint: "telegram" as const,
			externalId: "7",
			displayName: "Carol",
			id: "telegram:7",
		};
		const first = await store.ensureUser(caller);
		expect(first.id).toBe("telegram:7");
		const second = await store.ensureUser(caller);
		expect(second.id).toBe("telegram:7");
		expect(await store.listUsers()).toHaveLength(1);
	});
});
