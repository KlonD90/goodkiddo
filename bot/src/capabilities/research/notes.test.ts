import { describe, expect, test } from "bun:test";
import { mintId, ResearchNotes } from "./notes";

describe("ResearchNotes", () => {
	test("preserves insertion order", () => {
		const notes = new ResearchNotes();
		notes.add("source-a", "summary a");
		notes.add("source-b", "summary b");
		notes.add("source-c", "summary c");
		const md = notes.serializeMarkdown();
		const aIdx = md.indexOf("source-a");
		const bIdx = md.indexOf("source-b");
		const cIdx = md.indexOf("source-c");
		expect(aIdx).toBeLessThan(bIdx);
		expect(bIdx).toBeLessThan(cIdx);
	});

	test("markdown contains heading and source labels", () => {
		const notes = new ResearchNotes();
		notes.add("https://example.com", "interesting stuff");
		const md = notes.serializeMarkdown();
		expect(md).toMatch(/^# Research Notes/);
		expect(md).toContain("## Finding 1: https://example.com");
		expect(md).toContain("interesting stuff");
	});

	test("empty notes produces placeholder text", () => {
		const notes = new ResearchNotes();
		const md = notes.serializeMarkdown();
		expect(md).toMatch(/^# Research Notes/);
		expect(md).toContain("No findings recorded");
	});

	test("multiple findings are all present", () => {
		const notes = new ResearchNotes();
		for (let i = 1; i <= 5; i++) {
			notes.add(`source-${i}`, `summary ${i}`);
		}
		const md = notes.serializeMarkdown();
		for (let i = 1; i <= 5; i++) {
			expect(md).toContain(`source-${i}`);
			expect(md).toContain(`summary ${i}`);
		}
	});
});

describe("mintId", () => {
	test("returns id with r- prefix and 8 chars", () => {
		const id = mintId();
		expect(id).toMatch(/^r-[a-z0-9]{8}$/);
	});

	test("generates unique ids", () => {
		const ids = new Set(Array.from({ length: 200 }, mintId));
		expect(ids.size).toBe(200);
	});
});
