import type { PdfPage } from "./extractor.js";

export function buildPdfContent(pages: PdfPage[], filename: string): string {
	const pageCount = pages.length;
	const header = `_Document: ${filename} — ${pageCount} page${pageCount !== 1 ? "s" : ""}_`;

	const pageTexts = pages.map((page) => {
		const pageHeader = pageCount > 1 ? `--- Page ${page.pageNumber} ---\n` : "";
		return `${pageHeader}${page.text}`;
	});

	return `${header}\n\n${pageTexts.join("\n\n")}`;
}