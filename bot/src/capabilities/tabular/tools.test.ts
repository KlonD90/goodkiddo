import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../../backends";
import { createDb, detectDialect } from "../../db";
import type { TabularEngine, TabularRows, TabularSchema } from "./engine";
import { NoOpTabularEngine } from "./engine";
import { StreamingTabularEngine } from "./streaming_engine";
import {
	createTabularAggregateTool,
	createTabularDescribeTool,
	createTabularDistinctTool,
	createTabularFilterTool,
	createTabularHeadTool,
	createTabularSampleTool,
} from "./tools";

const FIXTURE_CSV = `name,age,city\nAlice,30,London\nBob,25,Paris\nCarol,30,London\n`;

function createWorkspace(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return { workspace: new SqliteStateBackend({ db, dialect, namespace }), db };
}

async function writeFile(workspace: SqliteStateBackend, path: string, content: string) {
	await workspace.write(path, content);
}

describe("tabular tool happy paths", () => {
	test("tabular_describe returns schema", async () => {
		const { workspace, db } = createWorkspace("tbl-describe");
		await writeFile(workspace, "/data.csv", FIXTURE_CSV);

		const engine = new StreamingTabularEngine();
		const t = createTabularDescribeTool({ engine, workspace });
		const result = await t.invoke({ path: "/data.csv" });

		const schema = JSON.parse(result as string) as TabularSchema;
		expect(schema.rowCount).toBe(3);
		expect(schema.columns.map((c) => c.name)).toEqual(["name", "age", "city"]);
		await db.close();
	});

	test("tabular_head returns first rows", async () => {
		const { workspace, db } = createWorkspace("tbl-head");
		await writeFile(workspace, "/data.csv", FIXTURE_CSV);

		const engine = new StreamingTabularEngine();
		const t = createTabularHeadTool({ engine, workspace });
		const result = await t.invoke({ path: "/data.csv", n: 2 });

		const parsed = JSON.parse(result as string) as TabularRows;
		expect(parsed.rows).toHaveLength(2);
		expect(parsed.columns).toEqual(["name", "age", "city"]);
		await db.close();
	});

	test("tabular_sample returns sampled rows", async () => {
		const { workspace, db } = createWorkspace("tbl-sample");
		await writeFile(workspace, "/data.csv", FIXTURE_CSV);

		const engine = new StreamingTabularEngine();
		const t = createTabularSampleTool({ engine, workspace });
		const result = await t.invoke({ path: "/data.csv", n: 2, seed: 42 });

		const parsed = JSON.parse(result as string) as TabularRows;
		expect(parsed.rows).toHaveLength(2);
		await db.close();
	});

	test("tabular_distinct returns unique values", async () => {
		const { workspace, db } = createWorkspace("tbl-distinct");
		await writeFile(workspace, "/data.csv", FIXTURE_CSV);

		const engine = new StreamingTabularEngine();
		const t = createTabularDistinctTool({ engine, workspace });
		const result = await t.invoke({ path: "/data.csv", column: "city", limit: 50 });

		const parsed = JSON.parse(result as string) as { column: string; values: unknown[] };
		expect(new Set(parsed.values)).toEqual(new Set(["London", "Paris"]));
		await db.close();
	});

	test("tabular_filter returns matching rows", async () => {
		const { workspace, db } = createWorkspace("tbl-filter");
		await writeFile(workspace, "/data.csv", FIXTURE_CSV);

		const engine = new StreamingTabularEngine();
		const t = createTabularFilterTool({ engine, workspace });
		const result = await t.invoke({
			path: "/data.csv",
			where: [{ column: "city", op: "eq", value: "London" }],
			limit: 50,
		});

		const parsed = JSON.parse(result as string) as TabularRows;
		expect(parsed.rows).toHaveLength(2);
		await db.close();
	});

	test("tabular_aggregate returns aggregated result", async () => {
		const { workspace, db } = createWorkspace("tbl-agg");
		await writeFile(workspace, "/data.csv", FIXTURE_CSV);

		const engine = new StreamingTabularEngine();
		const t = createTabularAggregateTool({ engine, workspace });
		const result = await t.invoke({
			path: "/data.csv",
			aggregations: [{ fn: "count" }],
		});

		const parsed = JSON.parse(result as string) as { rows: Record<string, unknown>[] };
		expect(parsed.rows[0]["count"]).toBe(3);
		await db.close();
	});
});

describe("oversized result truncation", () => {
	test("tabular_head appends truncation hint when over budget", async () => {
		const { workspace, db } = createWorkspace("tbl-trunc");
		// Build a large CSV that will exceed the 4000-token cap
		const header = "col" + Array.from({ length: 50 }, (_, i) => `,c${i}`).join("") + "\n";
		const row = "val" + Array.from({ length: 50 }, () => ",longvalue_________").join("") + "\n";
		const bigCsv = header + row.repeat(500);
		await writeFile(workspace, "/big.csv", bigCsv);

		const engine = new StreamingTabularEngine();
		const t = createTabularHeadTool({ engine, workspace });
		const result = (await t.invoke({ path: "/big.csv", n: 50 })) as string;

		expect(result).toContain("truncated");
		await db.close();
	});
});

describe("path resolution through workspace", () => {
	test("relative path is resolved to /path", async () => {
		const { workspace, db } = createWorkspace("tbl-relpath");
		await writeFile(workspace, "/data.csv", FIXTURE_CSV);

		const engine = new StreamingTabularEngine();
		const t = createTabularDescribeTool({ engine, workspace });
		const result = await t.invoke({ path: "data.csv" });
		const schema = JSON.parse(result as string) as TabularSchema;
		expect(schema.rowCount).toBe(3);
		await db.close();
	});
});

describe("engine errors surfaced as tool error strings", () => {
	test("NoOpTabularEngine error is returned as string", async () => {
		const { workspace, db } = createWorkspace("tbl-noop");
		await writeFile(workspace, "/data.csv", FIXTURE_CSV);

		const engine: TabularEngine = new NoOpTabularEngine();
		const t = createTabularDescribeTool({ engine, workspace });
		// LangChain tools return error messages as strings rather than throwing
		const result = (await t.invoke({ path: "/data.csv" })) as string;
		expect(result).toContain("Tabular engine not configured");
		await db.close();
	});
});
