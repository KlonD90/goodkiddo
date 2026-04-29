import { describe, expect, test } from "bun:test";
import {
	AGGREGATION_FNS,
	aggregateSchema,
	distinctSchema,
	filterSchema,
	headSchema,
	OPERATORS,
	sampleSchema,
} from "./schemas";

describe("OPERATORS / AGGREGATION_FNS completeness", () => {
	test("all expected operators present", () => {
		expect(OPERATORS).toContain("eq");
		expect(OPERATORS).toContain("ne");
		expect(OPERATORS).toContain("lt");
		expect(OPERATORS).toContain("lte");
		expect(OPERATORS).toContain("gt");
		expect(OPERATORS).toContain("gte");
		expect(OPERATORS).toContain("contains");
		expect(OPERATORS).toContain("in");
		expect(OPERATORS).toContain("between");
		expect(OPERATORS).toContain("isnull");
	});

	test("all expected aggregations present", () => {
		expect(AGGREGATION_FNS).toContain("count");
		expect(AGGREGATION_FNS).toContain("sum");
		expect(AGGREGATION_FNS).toContain("mean");
		expect(AGGREGATION_FNS).toContain("min");
		expect(AGGREGATION_FNS).toContain("max");
		expect(AGGREGATION_FNS).toContain("median");
		expect(AGGREGATION_FNS).toContain("stddev");
	});
});

describe("filterSchema", () => {
	test("accepts every operator", () => {
		for (const op of OPERATORS) {
			const result = filterSchema.safeParse({
				path: "data.csv",
				where: [{ column: "x", op, value: op === "isnull" ? undefined : "v" }],
				limit: 10,
			});
			expect(result.success, `operator ${op} should be accepted`).toBe(true);
		}
	});

	test("rejects unknown operator", () => {
		const result = filterSchema.safeParse({
			path: "data.csv",
			where: [{ column: "x", op: "UNKNOWN", value: "v" }],
			limit: 10,
		});
		expect(result.success).toBe(false);
	});

	test("rejects limit > 100", () => {
		const result = filterSchema.safeParse({
			path: "data.csv",
			where: [],
			limit: 101,
		});
		expect(result.success).toBe(false);
	});

	test("accepts limit == 100", () => {
		const result = filterSchema.safeParse({
			path: "data.csv",
			where: [],
			limit: 100,
		});
		expect(result.success).toBe(true);
	});
});

describe("headSchema / sampleSchema caps", () => {
	test("head: rejects n > 50", () => {
		const result = headSchema.safeParse({ path: "f.csv", n: 51 });
		expect(result.success).toBe(false);
	});

	test("head: accepts n == 50", () => {
		const result = headSchema.safeParse({ path: "f.csv", n: 50 });
		expect(result.success).toBe(true);
	});

	test("sample: rejects n > 50", () => {
		const result = sampleSchema.safeParse({ path: "f.csv", n: 51 });
		expect(result.success).toBe(false);
	});

	test("sample: accepts n == 50", () => {
		const result = sampleSchema.safeParse({ path: "f.csv", n: 50 });
		expect(result.success).toBe(true);
	});
});

describe("distinctSchema cap", () => {
	test("rejects limit > 200", () => {
		const result = distinctSchema.safeParse({
			path: "f.csv",
			column: "x",
			limit: 201,
		});
		expect(result.success).toBe(false);
	});

	test("accepts limit == 200", () => {
		const result = distinctSchema.safeParse({
			path: "f.csv",
			column: "x",
			limit: 200,
		});
		expect(result.success).toBe(true);
	});
});

describe("aggregateSchema", () => {
	test("accepts every aggregation function", () => {
		for (const fn of AGGREGATION_FNS) {
			const result = aggregateSchema.safeParse({
				path: "f.csv",
				aggregations: [{ fn }],
			});
			expect(result.success, `fn ${fn} should be accepted`).toBe(true);
		}
	});

	test("rejects unknown aggregation function", () => {
		const result = aggregateSchema.safeParse({
			path: "f.csv",
			aggregations: [{ fn: "variance" }],
		});
		expect(result.success).toBe(false);
	});

	test("requires at least one aggregation", () => {
		const result = aggregateSchema.safeParse({
			path: "f.csv",
			aggregations: [],
		});
		expect(result.success).toBe(false);
	});
});
