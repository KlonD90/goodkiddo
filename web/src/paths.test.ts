import { describe, expect, test } from "bun:test";
import { buildBreadcrumbs, isWithinScope, resolveRelativePath } from "./paths";

describe("resolveRelativePath", () => {
	test("strips query and hash before resolving local markdown links", () => {
		expect(resolveRelativePath("/reports/q1.md", "./q2.md#summary")).toBe(
			"/reports/q2.md",
		);
		expect(resolveRelativePath("/reports/q1.md", "../notes.md?plain=1")).toBe(
			"/notes.md",
		);
	});

	test("ignores document anchors and external schemes", () => {
		expect(resolveRelativePath("/reports/q1.md", "#summary")).toBeNull();
		expect(
			resolveRelativePath("/reports/q1.md", "https://example.com"),
		).toBeNull();
		expect(
			resolveRelativePath("/reports/q1.md", "mailto:team@example.com"),
		).toBeNull();
		expect(
			resolveRelativePath("/reports/q1.md", "tel:+15555555555"),
		).toBeNull();
	});

	test("preserves directory intent for links with trailing slashes", () => {
		expect(resolveRelativePath("/reports/q1.md", "./archive/")).toBe(
			"/reports/archive/",
		);
	});
});

describe("isWithinScope", () => {
	test("does not treat sibling path prefixes as in-scope", () => {
		expect(isWithinScope("/reports/q1.md", "/reports/")).toBe(true);
		expect(isWithinScope("/reports", "/reports/")).toBe(true);
		expect(isWithinScope("/reports-old/q1.md", "/reports/")).toBe(false);
	});
});

describe("buildBreadcrumbs", () => {
	test("builds crumbs without empty labels for scoped directories", () => {
		expect(buildBreadcrumbs("/reports/q1.md", "/reports/")).toEqual([
			{ label: "reports", path: "/reports/" },
			{ label: "q1.md", path: "/reports/q1.md" },
		]);
	});
});
