import { describe, expect, test } from "bun:test";
import { AccessStore, MAX_TTL_MS, withinScope } from "./access_store";

function createStore(now = 1_000_000) {
	let current = now;
	const store = new AccessStore({
		dbPath: ":memory:",
		now: () => current,
	});
	return {
		store,
		advance: (ms: number) => {
			current += ms;
		},
	};
}

describe("AccessStore.issue", () => {
	test("issues a root grant by default", () => {
		const { store } = createStore();
		const grant = store.issue("telegram:1");

		expect(grant.linkUuid.length).toBeGreaterThan(10);
		expect(grant.bearerToken.length).toBeGreaterThan(20);
		expect(grant.scopeKind).toBe("root");
		expect(grant.scopePath).toBe("/");
		expect(grant.userId).toBe("telegram:1");
	});

	test("caps ttl at 24h", () => {
		const { store } = createStore(1_000_000);
		const grant = store.issue("telegram:1", {
			ttlMs: MAX_TTL_MS * 10,
		});
		expect(grant.expiresAt).toBe(1_000_000 + MAX_TTL_MS);
	});

	test("normalizes dir scope path", () => {
		const { store } = createStore();
		const grant = store.issue("telegram:1", {
			scopePath: "/reports",
			scopeKind: "dir",
		});
		expect(grant.scopePath).toBe("/reports/");
		expect(grant.scopeKind).toBe("dir");
	});

	test("normalizes file scope path", () => {
		const { store } = createStore();
		const grant = store.issue("telegram:1", {
			scopePath: "/reports/q1.md",
			scopeKind: "file",
		});
		expect(grant.scopePath).toBe("/reports/q1.md");
		expect(grant.scopeKind).toBe("file");
	});
});

describe("AccessStore.resolveLink", () => {
	test("returns grant for valid link", () => {
		const { store } = createStore();
		const issued = store.issue("telegram:1");
		const resolved = store.resolveLink(issued.linkUuid);
		expect(resolved?.userId).toBe("telegram:1");
		expect(resolved?.scopeKind).toBe("root");
	});

	test("returns null for expired link", () => {
		const { store, advance } = createStore();
		const issued = store.issue("telegram:1", { ttlMs: 60_000 });
		advance(60_001);
		expect(store.resolveLink(issued.linkUuid)).toBeNull();
	});

	test("returns null for revoked link", () => {
		const { store } = createStore();
		const issued = store.issue("telegram:1");
		store.revokeByLink(issued.linkUuid);
		expect(store.resolveLink(issued.linkUuid)).toBeNull();
	});

	test("returns null for unknown link", () => {
		const { store } = createStore();
		expect(store.resolveLink("not-a-real-uuid")).toBeNull();
	});
});

describe("AccessStore.resolveBearer", () => {
	test("returns grant for valid bearer", () => {
		const { store } = createStore();
		const issued = store.issue("telegram:1", {
			scopePath: "/reports/",
			scopeKind: "dir",
		});
		const resolved = store.resolveBearer(issued.bearerToken);
		expect(resolved?.userId).toBe("telegram:1");
		expect(resolved?.scopePath).toBe("/reports/");
		expect(resolved?.linkUuid).toBe(issued.linkUuid);
	});

	test("returns null for empty bearer", () => {
		const { store } = createStore();
		expect(store.resolveBearer("")).toBeNull();
	});

	test("returns null for tampered bearer", () => {
		const { store } = createStore();
		const issued = store.issue("telegram:1");
		expect(store.resolveBearer(`${issued.bearerToken}x`)).toBeNull();
	});
});

describe("AccessStore.revokeByUser", () => {
	test("revokes all active grants for a user", () => {
		const { store } = createStore();
		const first = store.issue("telegram:1");
		const second = store.issue("telegram:1");
		const other = store.issue("telegram:2");

		const revoked = store.revokeByUser("telegram:1");

		expect(revoked).toBe(2);
		expect(store.resolveBearer(first.bearerToken)).toBeNull();
		expect(store.resolveBearer(second.bearerToken)).toBeNull();
		expect(store.resolveBearer(other.bearerToken)).not.toBeNull();
	});
});

describe("AccessStore.sweepExpired", () => {
	test("deletes rows past their expiry", () => {
		const { store, advance } = createStore();
		const shortLived = store.issue("telegram:1", { ttlMs: 60_000 });
		const longLived = store.issue("telegram:1", { ttlMs: MAX_TTL_MS });

		advance(60_001);
		const deleted = store.sweepExpired();

		expect(deleted).toBe(1);
		expect(store.resolveBearer(shortLived.bearerToken)).toBeNull();
		expect(store.resolveBearer(longLived.bearerToken)).not.toBeNull();
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
