import { describe, expect, test } from "bun:test";
import { NoOpTabularEngine, type TabularEngine } from "./engine";

describe("NoOpTabularEngine", () => {
	const engine = new NoOpTabularEngine();
	const data = new Uint8Array();

	test("describe throws", async () => {
		await expect(engine.describe(data, "test.csv")).rejects.toThrow(
			"Tabular engine not configured",
		);
	});

	test("head throws", async () => {
		await expect(engine.head(data, "test.csv", 5)).rejects.toThrow(
			"Tabular engine not configured",
		);
	});

	test("sample throws", async () => {
		await expect(engine.sample(data, "test.csv", 5)).rejects.toThrow(
			"Tabular engine not configured",
		);
	});

	test("distinct throws", async () => {
		await expect(engine.distinct(data, "test.csv", "col", 10)).rejects.toThrow(
			"Tabular engine not configured",
		);
	});

	test("filter throws", async () => {
		await expect(
			engine.filter(data, "test.csv", [], undefined, 10),
		).rejects.toThrow("Tabular engine not configured");
	});

	test("aggregate throws", async () => {
		await expect(
			engine.aggregate(data, "test.csv", undefined, [{ fn: "count" }]),
		).rejects.toThrow("Tabular engine not configured");
	});
});

describe("TabularEngine type contracts", () => {
	test("NoOpTabularEngine satisfies TabularEngine interface", () => {
		const engine: TabularEngine = new NoOpTabularEngine();
		expect(engine).toBeDefined();
		expect(typeof engine.describe).toBe("function");
		expect(typeof engine.head).toBe("function");
		expect(typeof engine.sample).toBe("function");
		expect(typeof engine.distinct).toBe("function");
		expect(typeof engine.filter).toBe("function");
		expect(typeof engine.aggregate).toBe("function");
	});
});
