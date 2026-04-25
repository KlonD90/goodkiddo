export interface PdfPage {
	pageNumber: number;
	text: string;
}

export interface PdfExtractionResult {
	pages: PdfPage[];
	isEncrypted: boolean;
	isCorrupt: string;
}

export interface PdfExtractor {
	extract(pdfBytes: Uint8Array, filename: string): Promise<PdfExtractionResult>;
}

export class NoOpPdfExtractor implements PdfExtractor {
	async extract(_pdfBytes: Uint8Array, _filename: string): Promise<PdfExtractionResult> {
		throw new Error("PDF extraction not configured");
	}
}