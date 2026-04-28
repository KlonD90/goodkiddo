import { describe, expect, test } from "bun:test";
import { depthToRecursionLimit, RESEARCH_SYSTEM_PROMPT } from "./prompts";

describe("depthToRecursionLimit", () => {
	test("quick returns 15", () => {
		expect(depthToRecursionLimit("quick")).toBe(15);
	});

	test("standard returns 40", () => {
		expect(depthToRecursionLimit("standard")).toBe(40);
	});

	test("deep returns 80", () => {
		expect(depthToRecursionLimit("deep")).toBe(80);
	});

	test("undefined defaults to standard (40)", () => {
		expect(depthToRecursionLimit(undefined)).toBe(40);
	});

	test("omitted argument defaults to standard (40)", () => {
		expect(depthToRecursionLimit()).toBe(40);
	});
});

describe("RESEARCH_SYSTEM_PROMPT", () => {
	test("is a non-empty string", () => {
		expect(typeof RESEARCH_SYSTEM_PROMPT).toBe("string");
		expect(RESEARCH_SYSTEM_PROMPT.length).toBeGreaterThan(0);
	});

	test("mentions record_finding", () => {
		expect(RESEARCH_SYSTEM_PROMPT).toContain("record_finding");
	});

	test("mentions tabular tools", () => {
		expect(RESEARCH_SYSTEM_PROMPT).toContain("tabular_");
	});

	test("mentions read-only constraint", () => {
		expect(RESEARCH_SYSTEM_PROMPT.toLowerCase()).toContain("read-only");
	});

	test("mentions offset and limit for pagination", () => {
		expect(RESEARCH_SYSTEM_PROMPT).toContain("offset");
		expect(RESEARCH_SYSTEM_PROMPT).toContain("limit");
	});

	test("snapshot matches expected shape", () => {
		expect(RESEARCH_SYSTEM_PROMPT).toMatchSnapshot();
	});
});
