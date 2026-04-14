import { describe, expect, test } from "bun:test";
import { matchesArguments, normalizeMatcher } from "./matcher";

describe("matcher", () => {
	test("null matcher matches any args", () => {
		expect(matchesArguments(null, { anything: 1 })).toBe(true);
		expect(matchesArguments(null, undefined)).toBe(true);
	});

	test("eq operator matches strings and primitives", () => {
		expect(
			matchesArguments({ runtime: { eq: "python" } }, { runtime: "python" }),
		).toBe(true);
		expect(
			matchesArguments({ runtime: { eq: "python" } }, { runtime: "bun" }),
		).toBe(false);
		expect(matchesArguments({ count: { eq: 3 } }, { count: 3 })).toBe(true);
	});

	test("in operator", () => {
		const matcher = { runtime: { in: ["python", "bun"] } };
		expect(matchesArguments(matcher, { runtime: "python" })).toBe(true);
		expect(matchesArguments(matcher, { runtime: "shell" })).toBe(false);
	});

	test("glob operator on file paths", () => {
		const matcher = { file_path: { glob: "drafts/**" } };
		expect(matchesArguments(matcher, { file_path: "drafts/today.md" })).toBe(
			true,
		);
		expect(matchesArguments(matcher, { file_path: "drafts/sub/x.md" })).toBe(
			true,
		);
		expect(matchesArguments(matcher, { file_path: "secret.md" })).toBe(false);
	});

	test("regex operator", () => {
		const matcher = { name: { regex: "^test_" } };
		expect(matchesArguments(matcher, { name: "test_foo" })).toBe(true);
		expect(matchesArguments(matcher, { name: "foo" })).toBe(false);
	});

	test("missing key fails the match", () => {
		expect(matchesArguments({ runtime: { eq: "python" } }, {})).toBe(false);
	});

	test("dotted paths into nested objects", () => {
		const matcher = { "args.runtime": { eq: "python" } };
		expect(matchesArguments(matcher, { args: { runtime: "python" } })).toBe(
			true,
		);
		expect(matchesArguments(matcher, { args: { runtime: "bun" } })).toBe(false);
	});

	test("normalizeMatcher canonicalizes key order", () => {
		const a = normalizeMatcher({ b: { eq: 1 }, a: { eq: 2 } });
		const b = normalizeMatcher({ a: { eq: 2 }, b: { eq: 1 } });
		expect(a).toBe(b);
	});

	test("normalizeMatcher null", () => {
		expect(normalizeMatcher(null)).toBeNull();
	});
});
