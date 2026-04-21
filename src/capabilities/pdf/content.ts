import type { PdfPage } from "./extractor.js";

export function buildPdfContent(pages: PdfPage[], filename: string): string {
	const sanitizedFilename = filename.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255);
	const pageCount = pages.length;
	const header = `_Document: ${sanitizedFilename} — ${pageCount} page${pageCount !== 1 ? "s" : ""}_`;

	const pageTexts = pages.map((page) => {
		const pageHeader = pageCount > 1 ? `--- Page ${page.pageNumber} ---\n` : "";
		return `${pageHeader}${page.text}`;
	});

	return `${header}\n\n${pageTexts.join("\n\n")}`;
}

export function buildPdfText(pages: PdfPage[]): string {
	return pages.map((page) => page.text).join("\n\n");
}