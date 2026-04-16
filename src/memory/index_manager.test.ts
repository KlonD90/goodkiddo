import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import {
	formatIndex,
	parseIndex,
	readIndexFile,
	removeEntry,
	upsertEntry,
	upsertIndexFile,
} from "./index_manager";

function createBackend(namespace: string) {
	return new SqliteStateBackend({ dbPath: ":memory:", namespace });
}

describe("parseIndex", () => {
	test("returns empty entries when no Index section", () => {
		const parsed = parseIndex("# MEMORY\n\nJust a header.");
		expect(parsed.entries).toEqual([]);
		expect(parsed.header).toContain("# MEMORY");
	});

	test("parses entries under ## Index", () => {
		const raw = [
			"# MEMORY",
			"",
			"## Index",
			"- [alpha](/memory/notes/alpha.md): first note",
			"- [beta](/memory/notes/beta.md): second note",
			"",
		].join("\n");
		const { header, entries } = parseIndex(raw);
		expect(header).toContain("# MEMORY");
		expect(entries).toEqual([
			{ slug: "alpha", path: "/memory/notes/alpha.md", hook: "first note" },
			{ slug: "beta", path: "/memory/notes/beta.md", hook: "second note" },
		]);
	});

	test("stops at next section heading", () => {
		const raw = [
			"# MEMORY",
			"## Index",
			"- [alpha](/a.md): first",
			"",
			"## Other",
			"- [skip](/skip.md): should not appear",
		].join("\n");
		const { entries } = parseIndex(raw);
		expect(entries.map((e) => e.slug)).toEqual(["alpha"]);
	});

	test("skips malformed lines silently", () => {
		const raw = [
			"# MEMORY",
			"## Index",
			"- [good](/good.md): ok",
			"- broken entry no brackets",
			"not a bullet either",
			"",
		].join("\n");
		const { entries } = parseIndex(raw);
		expect(entries.map((e) => e.slug)).toEqual(["good"]);
	});
});

describe("formatIndex", () => {
	test("sorts entries alphabetically by slug", () => {
		const out = formatIndex("# MEMORY", [
			{ slug: "zeta", path: "/z.md", hook: "z" },
			{ slug: "alpha", path: "/a.md", hook: "a" },
		]);
		const lines = out.split("\n");
		const alphaIdx = lines.findIndex((l) => l.includes("alpha"));
		const zetaIdx = lines.findIndex((l) => l.includes("zeta"));
		expect(alphaIdx).toBeLessThan(zetaIdx);
	});

	test("emits placeholder when no entries", () => {
		const out = formatIndex("# MEMORY", []);
		expect(out).toContain("## Index");
		expect(out).toContain("_No entries yet._");
	});

	test("round-trips through parseIndex", () => {
		const entries = [
			{ slug: "a", path: "/a.md", hook: "hook a" },
			{ slug: "b", path: "/b.md", hook: "hook b" },
		];
		const formatted = formatIndex("# MEMORY", entries);
		const parsed = parseIndex(formatted);
		expect(parsed.entries).toEqual(entries);
	});
});

describe("upsertEntry / removeEntry", () => {
	test("upsertEntry replaces entries with same slug", () => {
		const entries = [{ slug: "alpha", path: "/a.md", hook: "old" }];
		const next = upsertEntry(entries, {
			slug: "alpha",
			path: "/a.md",
			hook: "new",
		});
		expect(next).toHaveLength(1);
		expect(next[0]?.hook).toBe("new");
	});

	test("upsertEntry appends new slug", () => {
		const entries = [{ slug: "alpha", path: "/a.md", hook: "a" }];
		const next = upsertEntry(entries, {
			slug: "beta",
			path: "/b.md",
			hook: "b",
		});
		expect(next.map((e) => e.slug).sort()).toEqual(["alpha", "beta"]);
	});

	test("removeEntry drops the matching slug", () => {
		const entries = [
			{ slug: "alpha", path: "/a.md", hook: "a" },
			{ slug: "beta", path: "/b.md", hook: "b" },
		];
		const next = removeEntry(entries, "alpha");
		expect(next.map((e) => e.slug)).toEqual(["beta"]);
	});
});

describe("upsertIndexFile (backend)", () => {
	test("creates file when missing, parses back round-trip", async () => {
		const backend = createBackend("idx-create");
		const composed = await upsertIndexFile(backend, "/memory/MEMORY.md", {
			slug: "alpha",
			path: "/memory/notes/alpha.md",
			hook: "first note",
		});
		expect(composed).toContain("- [alpha](/memory/notes/alpha.md): first note");

		const re = await readIndexFile(backend, "/memory/MEMORY.md");
		expect(re.entries).toEqual([
			{ slug: "alpha", path: "/memory/notes/alpha.md", hook: "first note" },
		]);
	});

	test("upserts existing entry by slug", async () => {
		const backend = createBackend("idx-upsert");
		await upsertIndexFile(backend, "/memory/MEMORY.md", {
			slug: "alpha",
			path: "/memory/notes/alpha.md",
			hook: "v1",
		});
		await upsertIndexFile(backend, "/memory/MEMORY.md", {
			slug: "alpha",
			path: "/memory/notes/alpha.md",
			hook: "v2",
		});
		const { entries } = await readIndexFile(backend, "/memory/MEMORY.md");
		expect(entries).toEqual([
			{ slug: "alpha", path: "/memory/notes/alpha.md", hook: "v2" },
		]);
	});
});
