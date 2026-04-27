import { describe, expect, test } from "bun:test";
import { buildPdfContent } from "./content";
import type { PdfPage } from "./extractor";

describe("buildPdfContent", () => {
	test("formats single page PDF with italic prefix", () => {
		const pages: PdfPage[] = [{ pageNumber: 1, text: "Hello world" }];
		expect(buildPdfContent(pages, "doc.pdf")).toBe(
			"_Document: doc.pdf — 1 page_\n\nHello world",
		);
	});

	test("formats multi-page PDF with page separators", () => {
		const pages: PdfPage[] = [
			{ pageNumber: 1, text: "Page one content" },
			{ pageNumber: 2, text: "Page two content" },
		];
		expect(buildPdfContent(pages, "multi.pdf")).toBe(
			"_Document: multi.pdf — 2 pages_\n\n--- Page 1 ---\nPage one content\n\n--- Page 2 ---\nPage two content",
		);
	});

	test("uses singular page for single page count", () => {
		const pages: PdfPage[] = [{ pageNumber: 1, text: "Single" }];
		expect(buildPdfContent(pages, "single.pdf")).toBe(
			"_Document: single.pdf — 1 page_\n\nSingle",
		);
	});

	test("uses plural pages for multiple pages", () => {
		const pages: PdfPage[] = [
			{ pageNumber: 1, text: "First" },
			{ pageNumber: 2, text: "Second" },
			{ pageNumber: 3, text: "Third" },
		];
		expect(buildPdfContent(pages, "three.pdf")).toContain("3 pages");
	});
});