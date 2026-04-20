import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccessStore, MAX_TTL_MS, withinScope } from "./access_store";

let db: InstanceType<typeof Bun.SQL>;
let store: AccessStore;
let currentTime: number;

function advance(ms: number) {
	currentTime += ms;
}

beforeEach(() => {
	currentTime = 1_000_000;
	db = new Bun.SQL("sqlite://:memory:");
	store = new AccessStore({ db, dialect: "sqlite", now: () => currentTime });
});

afterEach(async () => {
	await db.close();
});

describe("AccessStore.issue", () => {
	test("issues a root grant by default", async () => {
		const grant = await store.issue("telegram:1");

		expect(grant.linkUuid.length).toBeGreaterThan(10);
		expect(grant.bearerToken.length).toBeGreaterThan(20);
		expect(grant.scopeKind).toBe("root");
		expect(grant.scopePath).toBe("/");
		expect(grant.userId).toBe("telegram:1");
	});

	test("caps ttl at 24h", async () => {
		const grant = await store.issue("telegram:1", {
			ttlMs: MAX_TTL_MS * 10,
		});
		expect(grant.expiresAt).toBe(1_000_000 + MAX_TTL_MS);
	});

	test("normalizes dir scope path", async () => {
		const grant = await store.issue("telegram:1", {
			scopePath: "/reports",
			scopeKind: "dir",
		});
		expect(grant.scopePath).toBe("/reports/");
		expect(grant.scopeKind).toBe("dir");
	});

	test("normalizes file scope path", async () => {
		const grant = await store.issue("telegram:1", {
			scopePath: "/reports/q1.md",
			scopeKind: "file",
		});
		expect(grant.scopePath).toBe("/reports/q1.md");
		expect(grant.scopeKind).toBe("file");
	});

	test("rejects ttlMs <= 0", async () => {
		await expect(store.issue("telegram:1", { ttlMs: 0 })).rejects.toThrow(
			"ttlMs must be positive",
		);
	});
});

describe("AccessStore.resolveLink", () => {
	test("returns grant for valid link", async () => {
		const issued = await store.issue("telegram:1");
		const resolved = await store.resolveLink(issued.linkUuid);
		expect(resolved?.userId).toBe("telegram:1");
		expect(resolved?.scopeKind).toBe("root");
	});

	test("returns null for expired link", async () => {
		const issued = await store.issue("telegram:1", { ttlMs: 60_000 });
		advance(60_001);
		expect(await store.resolveLink(issued.linkUuid)).toBeNull();
	});

	test("returns null for revoked link", async () => {
		const issued = await store.issue("telegram:1");
		await store.revokeByLink(issued.linkUuid);
		expect(await store.resolveLink(issued.linkUuid)).toBeNull();
	});

	test("returns null for unknown link", async () => {
		expect(await store.resolveLink("not-a-real-uuid")).toBeNull();
	});
});

describe("AccessStore.resolveBearer", () => {
	test("returns grant for valid bearer", async () => {
		const issued = await store.issue("telegram:1", {
			scopePath: "/reports/",
			scopeKind: "dir",
		});
		const resolved = await store.resolveBearer(issued.bearerToken);
		expect(resolved?.userId).toBe("telegram:1");
		expect(resolved?.scopePath).toBe("/reports/");
		expect(resolved?.linkUuid).toBe(issued.linkUuid);
	});

	test("returns null for empty bearer", async () => {
		expect(await store.resolveBearer("")).toBeNull();
	});

	test("returns null for tampered bearer", async () => {
		const issued = await store.issue("telegram:1");
		expect(await store.resolveBearer(`${issued.bearerToken}x`)).toBeNull();
	});
});

describe("AccessStore.revokeByUser", () => {
	test("revokes all active grants for a user", async () => {
		const first = await store.issue("telegram:1");
		const second = await store.issue("telegram:1");
		const other = await store.issue("telegram:2");

		const revoked = await store.revokeByUser("telegram:1");

		expect(revoked).toBe(2);
		expect(await store.resolveBearer(first.bearerToken)).toBeNull();
		expect(await store.resolveBearer(second.bearerToken)).toBeNull();
		expect(await store.resolveBearer(other.bearerToken)).not.toBeNull();
	});
});

describe("AccessStore.listActive", () => {
	test("returns active grants for a user", async () => {
		const g1 = await store.issue("telegram:1");
		const g2 = await store.issue("telegram:1", {
			scopePath: "/reports/",
			scopeKind: "dir",
		});
		const grants = await store.listActive("telegram:1");
		const uuids = grants.map((g) => g.linkUuid);
		expect(uuids).toContain(g1.linkUuid);
		expect(uuids).toContain(g2.linkUuid);
	});

	test("excludes grants from other users", async () => {
		await store.issue("telegram:1");
		const grants = await store.listActive("telegram:2");
		expect(grants).toHaveLength(0);
	});

	test("excludes expired grants", async () => {
		await store.issue("telegram:1", { ttlMs: 60_000 });
		advance(60_001);
		expect(await store.listActive("telegram:1")).toHaveLength(0);
	});

	test("excludes revoked grants", async () => {
		const issued = await store.issue("telegram:1");
		await store.revokeByLink(issued.linkUuid);
		expect(await store.listActive("telegram:1")).toHaveLength(0);
	});
});

describe("AccessStore.sweepExpired", () => {
	test("deletes rows past their expiry", async () => {
		const shortLived = await store.issue("telegram:1", { ttlMs: 60_000 });
		const longLived = await store.issue("telegram:1", { ttlMs: MAX_TTL_MS });

		advance(60_001);
		const deleted = await store.sweepExpired();

		expect(deleted).toBe(1);
		expect(await store.resolveBearer(shortLived.bearerToken)).toBeNull();
		expect(await store.resolveBearer(longLived.bearerToken)).not.toBeNull();
	});
});

describe("withinScope", () => {
	test("root scope allows anything", () => {
		expect(withinScope("/anywhere/at/all", "/", "root")).toBe(true);
	});

	test("dir scope allows the dir itself and descendants", () => {
		expect(withinScope("/reports/", "/reports/", "dir")).toBe(true);
		expect(withinScope("/reports", "/reports/", "dir")).toBe(true);
		expect(withinScope("/reports/q1.md", "/reports/", "dir")).toBe(true);
		expect(withinScope("/reports/sub/a.txt", "/reports/", "dir")).toBe(true);
	});

	test("dir scope rejects siblings", () => {
		expect(withinScope("/other/", "/reports/", "dir")).toBe(false);
		expect(withinScope("/reportsx/a.txt", "/reports/", "dir")).toBe(false);
	});

	test("file scope allows exact match only", () => {
		expect(withinScope("/reports/q1.md", "/reports/q1.md", "file")).toBe(true);
		expect(withinScope("/reports/q1.mdx", "/reports/q1.md", "file")).toBe(
			false,
		);
		expect(withinScope("/reports/", "/reports/q1.md", "file")).toBe(false);
	});
});
