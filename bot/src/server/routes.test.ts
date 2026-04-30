import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import { AccessStore } from "./access_store";
import { createWebHandler, type WebHandler } from "./routes";

function createHarness() {
	const dir = mkdtempSync(join(tmpdir(), "top-fedder-routes-"));
	const accessDbUrl = `sqlite://${join(dir, "access.db")}`;
	const databaseUrl = `sqlite://${join(dir, "state.db")}`;
	const db = createDb(databaseUrl);
	const dialect = detectDialect(databaseUrl);
	const access = new AccessStore({
		db: createDb(accessDbUrl),
		dialect: detectDialect(accessDbUrl),
	});
	const handler: WebHandler = createWebHandler({
		access,
		db,
		dialect,
		publicBaseUrl: "http://localhost:8787",
	});

	const seedWorkspace = async (userId: string) => {
		const ws = new SqliteStateBackend({ db, dialect, namespace: userId });
		await ws.write("/reports/q1.md", "# Q1 report\n\nHello world.");
		await ws.write("/reports/q2.md", "# Q2 report");
		await ws.write("/notes.txt", "Some notes.");
		await ws.uploadFiles([["/image.png", new Uint8Array([137, 80, 78, 71])]]);
		return ws;
	};

	const cleanup = () => {
		try {
			access.close();
		} catch {}
		void db.close();
		rmSync(dir, { recursive: true, force: true });
	};

	return { access, handler, seedWorkspace, databaseUrl, cleanup };
}

describe("GET /_boot", () => {
	test("returns boot payload for valid uuid", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		const grant = await access.issue("u1");
		const res = await handler(
			new Request(
				`http://localhost/_boot?uuid=${grant.linkUuid}&path=/`,
			),
		);
		expect(res.status).toBe(200);
		const boot = (await res.json()) as {
			bearer: string;
			scopeKind: string;
			initialPath: string;
			linkUuid: string;
		};
		expect(boot.bearer).toBe(grant.bearerToken);
		expect(boot.scopeKind).toBe("root");
		expect(boot.initialPath).toBe("/");
		expect(boot.linkUuid).toBe(grant.linkUuid);
		cleanup();
	});

	test("deep-link carries initialPath", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		const grant = await access.issue("u1");
		const res = await handler(
			new Request(
				`http://localhost/_boot?uuid=${grant.linkUuid}&path=/reports/q1.md`,
			),
		);
		expect(res.status).toBe(200);
		const boot = (await res.json()) as { initialPath: string };
		expect(boot.initialPath).toBe("/reports/q1.md");
		cleanup();
	});

	test("deep-link out of scope returns 404", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		const grant = await access.issue("u1", {
			scopePath: "/reports/",
			scopeKind: "dir",
		});
		const res = await handler(
			new Request(
				`http://localhost/_boot?uuid=${grant.linkUuid}&path=/other/`,
			),
		);
		expect(res.status).toBe(404);
		cleanup();
	});

	test("unknown uuid returns 404", async () => {
		const { handler, cleanup } = createHarness();
		const res = await handler(
			new Request(
				"http://localhost/_boot?uuid=12345678-1234-1234-1234-123456789abc",
			),
		);
		expect(res.status).toBe(404);
		cleanup();
	});

	test("non-uuid returns 404", async () => {
		const harness = createHarness();
		const res = await harness.handler(
			new Request("http://localhost/_boot?uuid=nope"),
		);
		expect(res.status).toBe(404);
		harness.cleanup();
	});

	test("wrong method returns 405", async () => {
		const { handler, cleanup } = createHarness();
		const res = await handler(
			new Request("http://localhost/_boot", { method: "POST" }),
		);
		expect(res.status).toBe(405);
		cleanup();
	});
});

describe("POST /api/fs/*", () => {
	test("ls returns directory entries for valid bearer", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		const ws = await seedWorkspace("u1");
		await ws.write("/prepared-followups/d-123.md", "# internal draft");
		const grant = await access.issue("u1");
		const res = await handler(
			new Request("http://localhost/api/fs/ls", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: Array<{ path: string }> };
		const paths = body.entries.map((e) => e.path).sort();
		expect(paths).toContain("/notes.txt");
		expect(paths).toContain("/image.png");
		expect(paths).toContain("/reports/");
		expect(paths).not.toContain("/prepared-followups/");
		cleanup();
	});

	test("missing bearer returns 401", async () => {
		const { handler, cleanup } = createHarness();
		const res = await handler(
			new Request("http://localhost/api/fs/ls", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: "/" }),
			}),
		);
		expect(res.status).toBe(401);
		cleanup();
	});

	test("preview returns base64 content", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		const grant = await access.issue("u1");
		const res = await handler(
			new Request("http://localhost/api/fs/preview", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/reports/q1.md" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			mime: string;
			content_base64: string;
		};
		expect(body.mime).toBe("text/markdown");
		const text = Buffer.from(body.content_base64, "base64").toString("utf8");
		expect(text).toContain("Q1 report");
		cleanup();
	});

	test("root-scoped grants cannot preview internal prepared follow-up drafts", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		const ws = await seedWorkspace("u1");
		await ws.write("/prepared-followups/d-123.md", "# internal draft");
		const grant = await access.issue("u1");
		const res = await handler(
			new Request("http://localhost/api/fs/preview", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/prepared-followups/d-123.md" }),
			}),
		);
		expect(res.status).toBe(404);
		cleanup();
	});

	test("root-scoped grants cannot list internal prepared follow-up drafts", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		const ws = await seedWorkspace("u1");
		await ws.write("/prepared-followups/d-123.md", "# internal draft");
		const grant = await access.issue("u1");
		const res = await handler(
			new Request("http://localhost/api/fs/ls", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/prepared-followups/" }),
			}),
		);
		expect(res.status).toBe(404);
		cleanup();
	});

	test("dir-scoped grant can ls its dir but not a sibling", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		await seedWorkspace("u2");
		const grant = await access.issue("u1", {
			scopePath: "/reports/",
			scopeKind: "dir",
		});
		const okRes = await handler(
			new Request("http://localhost/api/fs/ls", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/reports/" }),
			}),
		);
		expect(okRes.status).toBe(200);
		const otherRes = await handler(
			new Request("http://localhost/api/fs/ls", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/other/" }),
			}),
		);
		expect(otherRes.status).toBe(403);
		cleanup();
	});

	test("file-scoped grant rejects ls and rejects preview of other file", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		const grant = await access.issue("u1", {
			scopePath: "/reports/q1.md",
			scopeKind: "file",
		});
		const lsRes = await handler(
			new Request("http://localhost/api/fs/ls", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/reports/" }),
			}),
		);
		expect(lsRes.status).toBe(403);
		const otherPreview = await handler(
			new Request("http://localhost/api/fs/preview", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/reports/q2.md" }),
			}),
		);
		expect(otherPreview.status).toBe(403);
		const okPreview = await handler(
			new Request("http://localhost/api/fs/preview", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/reports/q1.md" }),
			}),
		);
		expect(okPreview.status).toBe(200);
		cleanup();
	});

	test("user B's bearer cannot read user A's files (namespace isolation)", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		await seedWorkspace("u2");
		const grantB = await access.issue("u2");
		const res = await handler(
			new Request("http://localhost/api/fs/ls", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grantB.bearerToken}`,
				},
				body: JSON.stringify({ path: "/" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: Array<{ path: string }> };
		expect(body.entries.length).toBeGreaterThan(0);
		const badRes = await handler(
			new Request("http://localhost/api/fs/ls", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer not-a-real-bearer",
				},
				body: JSON.stringify({ path: "/" }),
			}),
		);
		expect(badRes.status).toBe(401);
		cleanup();
	});

	test("path traversal cannot escape user's virtual namespace", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		const grant = await access.issue("u1");
		const res = await handler(
			new Request("http://localhost/api/fs/preview", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/../../etc/passwd" }),
			}),
		);
		expect(res.status).toBe(404);
		cleanup();
	});
});

describe("GET /_dl", () => {
	test("download returns file with correct headers", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		const grant = await access.issue("u1");
		const res = await handler(
			new Request(
				`http://localhost/_dl?uuid=${grant.linkUuid}&path=/reports/q1.md`,
			),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/markdown");
		expect(res.headers.get("content-disposition")).toContain("q1.md");
		const text = await res.text();
		expect(text).toContain("Q1 report");
		cleanup();
	});

	test("root-scoped grants cannot download internal prepared follow-up drafts", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		const ws = await seedWorkspace("u1");
		await ws.write("/prepared-followups/d-123.md", "# internal draft");
		const grant = await access.issue("u1");
		const res = await handler(
			new Request(
				`http://localhost/_dl?uuid=${grant.linkUuid}&path=/prepared-followups/d-123.md`,
			),
		);
		expect(res.status).toBe(404);
		cleanup();
	});

	test("wrong uuid is rejected", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		const grantA = await access.issue("u1");
		const grantB = await access.issue("u1");
		const crossRes = await handler(
			new Request(
				`http://localhost/_dl?uuid=${grantA.linkUuid}&path=/reports/q1.md`,
			),
		);
		expect(crossRes.status).toBe(200);

		const junkRes = await handler(
			new Request(
				"http://localhost/_dl?uuid=wrong-uuid&path=/reports/q1.md",
			),
		);
		expect(junkRes.status).toBe(401);
		cleanup();
	});

	test("missing uuid returns 400", async () => {
		const { handler, cleanup } = createHarness();
		const res = await handler(
			new Request("http://localhost/_dl?path=/reports/q1.md"),
		);
		expect(res.status).toBe(400);
		cleanup();
	});

	test("out of scope download returns 403", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		const grant = await access.issue("u1", {
			scopePath: "/reports/",
			scopeKind: "dir",
		});
		const res = await handler(
			new Request(
				`http://localhost/_dl?uuid=${grant.linkUuid}&path=/notes.txt`,
			),
		);
		expect(res.status).toBe(403);
		cleanup();
	});
});

describe("revocation and expiry", () => {
	test("revoked grant returns 404 on boot and 401 on API", async () => {
		const { access, handler, seedWorkspace, cleanup } = createHarness();
		await seedWorkspace("u1");
		const grant = await access.issue("u1");
		await access.revokeByLink(grant.linkUuid);

		const bootRes = await handler(
			new Request(`http://localhost/_boot?uuid=${grant.linkUuid}`),
		);
		expect(bootRes.status).toBe(404);

		const apiRes = await handler(
			new Request("http://localhost/api/fs/ls", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${grant.bearerToken}`,
				},
				body: JSON.stringify({ path: "/" }),
			}),
		);
		expect(apiRes.status).toBe(401);
		cleanup();
	});
});
