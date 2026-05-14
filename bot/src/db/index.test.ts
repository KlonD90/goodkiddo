import { describe, expect, test } from "bun:test";
import { detectDialect } from "./index";

describe("detectDialect", () => {
	test("returns postgres for postgres: scheme", () => {
		expect(detectDialect("postgres://host/db")).toBe("postgres");
	});

	test("returns postgres for postgresql: scheme", () => {
		expect(detectDialect("postgresql://user:pass@host/db")).toBe("postgres");
	});

	test("throws for unsupported scheme", () => {
		expect(() => detectDialect("mysql://host/db")).toThrow(
			"Unsupported database URL scheme: mysql://host/db",
		);
	});

	test("throws for sqlite URLs", () => {
		expect(() => detectDialect("sqlite://./state.db")).toThrow(
			"Unsupported database URL scheme: sqlite://./state.db",
		);
	});

	test("throws for empty string", () => {
		expect(() => detectDialect("")).toThrow(
			"Unsupported database URL scheme: ",
		);
	});
});
