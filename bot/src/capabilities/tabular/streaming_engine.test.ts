import { describe, expect, test } from "bun:test";
import { StreamingTabularEngine } from "./streaming_engine";

// name,age,score,city
const FIXTURE_CSV = `name,age,score,city
Alice,30,95.5,London
Bob,25,80.0,Paris
Carol,30,87.3,London
Dave,25,72.1,Berlin
Eve,35,91.0,Paris
Frank,35,60.0,Berlin
`;

function csvBytes(csv: string): Uint8Array {
	return new TextEncoder().encode(csv);
}

const engine = new StreamingTabularEngine();
const data = csvBytes(FIXTURE_CSV);
const filename = "data.csv";

describe("StreamingTabularEngine.describe", () => {
	test("returns column names and row count", async () => {
		const schema = await engine.describe(data, filename);
		expect(schema.path).toBe(filename);
		expect(schema.sheet).toBe("Sheet1");
		expect(schema.rowCount).toBe(6);
		expect(schema.columns.map((c) => c.name)).toEqual([
			"name",
			"age",
			"score",
			"city",
		]);
	});

	test("infers number dtype for numeric columns", async () => {
		const schema = await engine.describe(data, filename);
		const age = schema.columns.find((c) => c.name === "age");
		expect(age?.dtype).toBe("number");
	});

	test("infers string dtype for text columns", async () => {
		const schema = await engine.describe(data, filename);
		const name = schema.columns.find((c) => c.name === "name");
		expect(name?.dtype).toBe("string");
	});
});

describe("StreamingTabularEngine.head", () => {
	test("returns first n rows", async () => {
		const result = await engine.head(data, filename, 3);
		expect(result.columns).toEqual(["name", "age", "score", "city"]);
		expect(result.rows).toHaveLength(3);
		expect(result.rows[0][0]).toBe("Alice");
	});

	test("returns fewer rows when file has fewer than n", async () => {
		const result = await engine.head(data, filename, 100);
		expect(result.rows).toHaveLength(6);
	});
});

describe("StreamingTabularEngine.sample", () => {
	test("returns n rows", async () => {
		const result = await engine.sample(data, filename, 3, undefined, 42);
		expect(result.rows).toHaveLength(3);
		expect(result.columns).toEqual(["name", "age", "score", "city"]);
	});

	test("is deterministic with the same seed", async () => {
		const a = await engine.sample(data, filename, 3, undefined, 7);
		const b = await engine.sample(data, filename, 3, undefined, 7);
		expect(a.rows).toEqual(b.rows);
	});

	test("differs across different seeds", async () => {
		const a = await engine.sample(data, filename, 3, undefined, 1);
		const b = await engine.sample(data, filename, 3, undefined, 999);
		// At least one row should differ
		const aStr = JSON.stringify(a.rows);
		const bStr = JSON.stringify(b.rows);
		expect(aStr).not.toBe(bStr);
	});

	test("returns all rows when count <= n", async () => {
		const result = await engine.sample(data, filename, 100, undefined, 0);
		expect(result.rows).toHaveLength(6);
	});
});

describe("StreamingTabularEngine.distinct", () => {
	test("returns unique values for a column", async () => {
		const result = await engine.distinct(data, filename, "city", 200);
		expect(result.column).toBe("city");
		expect(new Set(result.values)).toEqual(
			new Set(["London", "Paris", "Berlin"]),
		);
	});

	test("respects limit", async () => {
		const result = await engine.distinct(data, filename, "city", 2);
		expect(result.values).toHaveLength(2);
	});

	test("throws on unknown column", async () => {
		await expect(
			engine.distinct(data, filename, "nonexistent", 10),
		).rejects.toThrow("Column \"nonexistent\" not found");
	});
});

describe("StreamingTabularEngine.filter — operators", () => {
	test("eq", async () => {
		const result = await engine.filter(
			data,
			filename,
			[{ column: "city", op: "eq", value: "London" }],
			undefined,
			100,
		);
		expect(result.rows).toHaveLength(2);
		expect(result.rows.every((r) => r[3] === "London")).toBe(true);
	});

	test("ne", async () => {
		const result = await engine.filter(
			data,
			filename,
			[{ column: "city", op: "ne", value: "London" }],
			undefined,
			100,
		);
		expect(result.rows).toHaveLength(4);
	});

	test("lt", async () => {
		const result = await engine.filter(
			data,
			filename,
			[{ column: "age", op: "lt", value: 30 }],
			undefined,
			100,
		);
		expect(result.rows).toHaveLength(2);
	});

	test("lte", async () => {
		const result = await engine.filter(
			data,
			filename,
			[{ column: "age", op: "lte", value: 30 }],
			undefined,
			100,
		);
		expect(result.rows).toHaveLength(4);
	});

	test("gt", async () => {
		const result = await engine.filter(
			data,
			filename,
			[{ column: "age", op: "gt", value: 30 }],
			undefined,
			100,
		);
		expect(result.rows).toHaveLength(2);
	});

	test("gte", async () => {
		const result = await engine.filter(
			data,
			filename,
			[{ column: "age", op: "gte", value: 30 }],
			undefined,
			100,
		);
		expect(result.rows).toHaveLength(4);
	});

	test("contains", async () => {
		const result = await engine.filter(
			data,
			filename,
			[{ column: "name", op: "contains", value: "a" }],
			undefined,
			100,
		);
		// Carol, Dave, Frank all contain 'a'
		expect(result.rows.length).toBeGreaterThanOrEqual(3);
	});

	test("in", async () => {
		const result = await engine.filter(
			data,
			filename,
			[{ column: "city", op: "in", value: ["London", "Paris"] }],
			undefined,
			100,
		);
		expect(result.rows).toHaveLength(4);
	});

	test("between", async () => {
		const result = await engine.filter(
			data,
			filename,
			[{ column: "score", op: "between", value: [80, 95] }],
			undefined,
			100,
		);
		// Bob(80), Carol(87.3), Eve(91.0), Alice(95.5) - Alice is above 95
		expect(result.rows.length).toBeGreaterThanOrEqual(3);
	});

	test("isnull", async () => {
		const csvWithNull = `a,b\n1,\n2,hello\n3,`;
		const result = await engine.filter(
			csvBytes(csvWithNull),
			"test.csv",
			[{ column: "b", op: "isnull" }],
			undefined,
			100,
		);
		expect(result.rows).toHaveLength(2);
	});

	test("select projects to specified columns", async () => {
		const result = await engine.filter(
			data,
			filename,
			[{ column: "city", op: "eq", value: "London" }],
			["name", "age"],
			100,
		);
		expect(result.columns).toEqual(["name", "age"]);
		expect(result.rows[0]).toHaveLength(2);
	});

	test("respects limit", async () => {
		const result = await engine.filter(data, filename, [], undefined, 2);
		expect(result.rows).toHaveLength(2);
	});
});

describe("StreamingTabularEngine.aggregate", () => {
	test("count all rows", async () => {
		const result = await engine.aggregate(data, filename, undefined, [
			{ fn: "count" },
		]);
		expect(result.rows[0]["count"]).toBe(6);
	});

	test("sum numeric column", async () => {
		const result = await engine.aggregate(data, filename, undefined, [
			{ fn: "sum", column: "age" },
		]);
		expect(result.rows[0]["sum(age)"]).toBe(30 + 25 + 30 + 25 + 35 + 35);
	});

	test("mean numeric column", async () => {
		const result = await engine.aggregate(data, filename, undefined, [
			{ fn: "mean", column: "age" },
		]);
		expect(result.rows[0]["mean(age)"]).toBeCloseTo(30);
	});

	test("min/max numeric column", async () => {
		const result = await engine.aggregate(data, filename, undefined, [
			{ fn: "min", column: "age" },
			{ fn: "max", column: "age" },
		]);
		expect(result.rows[0]["min(age)"]).toBe(25);
		expect(result.rows[0]["max(age)"]).toBe(35);
	});

	test("median numeric column", async () => {
		const result = await engine.aggregate(data, filename, undefined, [
			{ fn: "median", column: "age" },
		]);
		// ages: 25,25,30,30,35,35 → median = 30
		expect(result.rows[0]["median(age)"]).toBe(30);
	});

	test("stddev numeric column", async () => {
		const result = await engine.aggregate(data, filename, undefined, [
			{ fn: "stddev", column: "age" },
		]);
		expect(typeof result.rows[0]["stddev(age)"]).toBe("number");
	});

	test("groupBy city with count", async () => {
		const result = await engine.aggregate(data, filename, ["city"], [
			{ fn: "count" },
		]);
		const byCity: Record<string, number> = {};
		for (const row of result.rows) {
			byCity[String(row.city)] = Number(row.count);
		}
		expect(byCity["London"]).toBe(2);
		expect(byCity["Paris"]).toBe(2);
		expect(byCity["Berlin"]).toBe(2);
	});

	test("alias is used as column name", async () => {
		const result = await engine.aggregate(data, filename, undefined, [
			{ fn: "count", alias: "total" },
		]);
		expect(result.rows[0]["total"]).toBe(6);
	});

	test("where clause is applied before aggregation", async () => {
		const result = await engine.aggregate(
			data,
			filename,
			undefined,
			[{ fn: "count" }],
			[{ column: "city", op: "eq", value: "London" }],
		);
		expect(result.rows[0]["count"]).toBe(2);
	});
});

describe("StreamingTabularEngine errors", () => {
	test("throws on unsupported file format", async () => {
		await expect(
			engine.describe(new Uint8Array(), "data.json"),
		).rejects.toThrow("Unsupported file format");
	});

	test("throws on unknown column in filter", async () => {
		await expect(
			engine.filter(
				data,
				filename,
				[{ column: "missing", op: "eq", value: "x" }],
				undefined,
				10,
			),
		).rejects.toThrow("Column \"missing\" not found");
	});
});
