import * as XLSX from "xlsx";
import type { SpreadsheetParser, SpreadsheetParseResult } from "./parser";

export class ExcelParser implements SpreadsheetParser {
	async parse(data: Uint8Array, _filename: string, _mimeType: string): Promise<SpreadsheetParseResult> {
		try {
			const workbook = XLSX.read(data, { type: "array", cellDates: true, cellNF: true });
			if (workbook.SheetNames.length === 0) {
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

			const sheets = workbook.SheetNames.map((sheetName) => {
				const worksheet = workbook.Sheets[sheetName];
				const jsonData = XLSX.utils.sheet_to_json<string[]>(worksheet, { header: 1, defval: "" });
				const nonEmptyRows = this.filterEmptyRows(jsonData);

				if (nonEmptyRows.length === 0) {
					return {
						name: sheetName,
						headers: [],
						rows: [] as string[][],
						rowCount: 0,
						colCount: 0
					};
				}

				const headers = nonEmptyRows[0].map((h) => String(h).trim());
				const rows = nonEmptyRows.slice(1).map((row) =>
					row.map((cell) => {
						if (cell === null || cell === undefined) return "";
						if (typeof cell === "object" && "v" in cell) {
							const value = (cell as { v: unknown }).v;
							if (value instanceof Date) return value.toISOString().slice(0, 10);
							if (typeof value === "object" && value !== null) return JSON.stringify(value);
							return String(value).trim();
						}
						return String(cell).trim();
					})
				);
				const filteredRows = rows.filter((row) => row.some((cell) => cell !== ""));

				return {
					name: sheetName,
					headers,
					rows: filteredRows,
					rowCount: filteredRows.length,
					colCount: headers.length
				};
			});

			const allRowsEmpty = sheets.every((s) => s.rowCount === 0);

			return {
				sheets,
				isEmpty: allRowsEmpty,
				isCorrupt: false
			};
		} catch (err) {
			console.error("Excel parse error:", err);
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

	private filterEmptyRows(rows: unknown[][]): unknown[][] {
		return rows.filter((row) => {
			if (!Array.isArray(row)) return false;
			return row.some((cell) => {
				if (cell === null || cell === undefined) return false;
				if (typeof cell === "object" && "v" in cell) return (cell as { v: unknown }).v !== "";
				return String(cell).trim() !== "";
			});
		});
	}
}