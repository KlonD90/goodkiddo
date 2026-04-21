export interface SpreadsheetParseResult {
	sheets: Array<{
		name: string;
		headers: string[];
		rows: string[][];
		rowCount: number;
		colCount: number;
	}>;
	isEmpty: boolean;
	isCorrupt: boolean;
}

export interface SpreadsheetParser {
	parse(data: Uint8Array, filename: string, mimeType: string): Promise<SpreadsheetParseResult>;
}

export class NoOpSpreadsheetParser implements SpreadsheetParser {
	async parse(_data: Uint8Array, _filename: string, _mimeType: string): Promise<SpreadsheetParseResult> {
		throw new Error("Spreadsheet parsing not configured");
	}
}