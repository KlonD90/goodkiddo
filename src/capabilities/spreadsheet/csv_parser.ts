import { parse } from "csv-parse";
import type { SpreadsheetParser, SpreadsheetParseResult } from "./parser";

export class CsvParser implements SpreadsheetParser {
	async parse(data: Uint8Array, _filename: string, _mimeType: string): Promise<SpreadsheetParseResult> {
		try {
			const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
			if (!text.trim()) {
				return {
					sheets: [{
						name: "Sheet1",
						headers: [],
						rows: [],
						rowCount: 0,
						colCount: 0
					}],
					isEmpty: true,
					isCorrupt: false
				};
			}

			const delimiter = this.detectDelimiter(text);
			const records = await this.parseCsv(text, delimiter);
			if (records.length === 0) {
				return {
					sheets: [{
						name: "Sheet1",
						headers: [],
						rows: [],
						rowCount: 0,
						colCount: 0
					}],
					isEmpty: true,
					isCorrupt: false
				};
			}

			const headers = records[0].map((h: string) => h.trim());
			const rows = records.slice(1).map((row: string[]) => row.map((cell: string) => cell.trim()));
			const nonEmptyRows = rows.filter((row: string[]) => row.some((cell: string) => cell !== ""));

			return {
				sheets: [{
					name: "Sheet1",
					headers,
					rows: nonEmptyRows,
					rowCount: nonEmptyRows.length,
					colCount: headers.length
				}],
				isEmpty: nonEmptyRows.length === 0,
				isCorrupt: false
			};
		} catch (err) {
			console.error("CSV parse error:", err);
			const message = err instanceof Error ? err.message : "Unknown parse error";
			return {
				sheets: [{
					name: "Sheet1",
					headers: [],
					rows: [],
					rowCount: 0,
					colCount: 0
				}],
				isEmpty: false,
				isCorrupt: true,
				errorMessage: message
			};
		}
	}

	private detectDelimiter(text: string): string {
		const firstLines = text.split("\n").slice(0, 5).join("\n");
		const delimiters = [",", ";", "\t"];
		let maxCount = 0;
		let detected = ",";

		for (const delimiter of delimiters) {
			const count = firstLines.split(delimiter).length - 1;
			if (count > maxCount) {
				maxCount = count;
				detected = delimiter;
			}
		}

		return detected;
	}

	private parseCsv(text: string, delimiter: string): Promise<string[][]> {
		return new Promise((resolve, reject) => {
			const parser = parse(text, {
				delimiter,
				quote: '"',
				escape: '"',
				skip_empty_lines: true,
				trim: true
			});
			const records: string[][] = [];
			const csvParser = parser;
			csvParser.on("readable", function (this: ReturnType<typeof parse>) {
				let record: string[] | null;
				while (true) {
					record = this.read();
					if (record === null) break;
					records.push(record);
				}
			});
			csvParser.on("error", reject);
			csvParser.on("end", () => resolve(records));
		});
	}
}