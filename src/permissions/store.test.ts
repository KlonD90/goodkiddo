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

	test("createUserFree creates a free-tier user", async () => {
		const created = await store.createUserFree({
			entrypoint: "telegram",
			externalId: "10",
			displayName: "FreeUser",
		});
		expect(created.id).toBe("telegram:10");
		expect(created.tier).toBe("free");
		expect(created.status).toBe("active");
		expect(created.displayName).toBe("FreeUser");
	});

	test("createUserFree does not overwrite existing paid user", async () => {
		await store.upsertUserPaid({
			entrypoint: "telegram",
			externalId: "11",
			displayName: "PaidUser",
		});
		const created = await store.createUserFree({
			entrypoint: "telegram",
			externalId: "11",
			displayName: "Overwritten",
		});
		expect(created.id).toBe("telegram:11");
		expect(created.tier).toBe("paid");
		expect(created.displayName).toBe("PaidUser");
	});

	test("upgradeToPaid upgrades free to paid", async () => {
		await store.createUserFree({
			entrypoint: "telegram",
			externalId: "12",
		});
		const upgraded = await store.upgradeToPaid("telegram:12");
		expect(upgraded.tier).toBe("paid");
		expect(upgraded.status).toBe("active");
	});

	test("upgradeToPaid preserves status", async () => {
		await store.createUserFree({
			entrypoint: "telegram",
			externalId: "13",
		});
		await store.setUserStatus("telegram:13", "suspended");
		const upgraded = await store.upgradeToPaid("telegram:13");
		expect(upgraded.tier).toBe("paid");
		expect(upgraded.status).toBe("suspended");
	});

	test("upsertUserPaid creates new paid user", async () => {
		const created = await store.upsertUserPaid({
			entrypoint: "telegram",
			externalId: "14",
			displayName: "NewPaid",
		});
		expect(created.id).toBe("telegram:14");
		expect(created.tier).toBe("paid");
		expect(created.status).toBe("active");
	});

	test("upsertUserPaid upgrades existing free to paid", async () => {
		await store.createUserFree({
			entrypoint: "telegram",
			externalId: "15",
			displayName: "FreeUser",
		});
		const upgraded = await store.upsertUserPaid({
			entrypoint: "telegram",
			externalId: "15",
			displayName: "UpdatedPaid",
		});
		expect(upgraded.tier).toBe("paid");
		expect(upgraded.displayName).toBe("UpdatedPaid");
	});

	test("tier is independent from status", async () => {
		await store.createUserFree({
			entrypoint: "telegram",
			externalId: "16",
		});
		expect((await store.getUser("telegram", "16"))?.tier).toBe("free");
		await store.setUserStatus("telegram:16", "suspended");
		expect((await store.getUser("telegram", "16"))?.tier).toBe("free");
		expect((await store.getUser("telegram", "16"))?.status).toBe("suspended");
	});

	test("ensureUser creates free-tier user", async () => {
		const caller = {
			entrypoint: "telegram" as const,
			externalId: "20",
			displayName: "AutoFree",
			id: "telegram:20",
		};
		const created = await store.ensureUser(caller);
		expect(created.tier).toBe("free");
	});

	test("ensureUser preserves existing tier", async () => {
		await store.createUserFree({
			entrypoint: "telegram",
			externalId: "21",
		});
		await store.upgradeToPaid("telegram:21");
		const caller = {
			entrypoint: "telegram" as const,
			externalId: "21",
			id: "telegram:21",
		};
		const existing = await store.ensureUser(caller);
		expect(existing.tier).toBe("paid");
	});

	test("listUsers includes tier", async () => {
		await store.createUserFree({ entrypoint: "telegram", externalId: "30" });
		await store.upsertUserPaid({ entrypoint: "telegram", externalId: "31" });
		const users = await store.listUsers();
		expect(users).toHaveLength(2);
		expect(users[0].tier).toBe("free");
		expect(users[1].tier).toBe("paid");
	});
});
