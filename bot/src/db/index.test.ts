import { describe, expect, test } from "bun:test";
import { detectDialect } from "./index";

describe("detectDialect", () => {
	test("returns sqlite for sqlite: scheme", () => {
		expect(detectDialect("sqlite://./state.db")).toBe("sqlite");
	});

	test("returns sqlite for sqlite: scheme without authority", () => {
		expect(detectDialect("sqlite:./state.db")).toBe("sqlite");
	});

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

	test("throws for empty string", () => {
		expect(() => detectDialect("")).toThrow(
			"Unsupported database URL scheme: ",
		);
	});
});
