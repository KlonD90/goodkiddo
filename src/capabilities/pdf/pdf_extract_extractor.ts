import {
	PDFParse,
	PasswordException,
	InvalidPDFException,
	FormatError,
} from "pdf-parse";
import type { PdfExtractor, PdfExtractionResult } from "./extractor";

export type PdfParserFactory = (params: { data: Uint8Array }) => {
	getText(): Promise<{
		pages: Array<{ num: number; text: string }>;
		text: string;
		total: number;
	}>;
	destroy(): Promise<void>;
};

export class PdfExtractExtractor implements PdfExtractor {
	private readonly parserFactory: PdfParserFactory;

	constructor(parserFactory?: PdfParserFactory) {
		this.parserFactory = parserFactory ?? ((params) => new PDFParse(params));
	}

	async extract(
		pdfBytes: Uint8Array,
		filename: string,
	): Promise<PdfExtractionResult> {
		const parser = this.parserFactory({ data: pdfBytes });

		try {
			const result = await parser.getText();

			const pages = result.pages.map((page) => ({
				pageNumber: page.num,
				text: page.text,
			}));

			return {
				pages,
				isEncrypted: false,
				isCorrupt: false,
			};
		} catch (error) {
			if (error instanceof PasswordException) {
				return {
					pages: [],
					isEncrypted: true,
					isCorrupt: false,
				};
			}

			if (error instanceof InvalidPDFException || error instanceof FormatError) {
				return {
					pages: [],
					isEncrypted: false,
					isCorrupt: true,
				};
			}

			if (error instanceof Error) {
				return {
					pages: [],
					isEncrypted: false,
					isCorrupt: true,
				};
			}

			return {
				pages: [],
				isEncrypted: false,
				isCorrupt: true,
			};
		} finally {
			await parser.destroy();
		}
	}
}
