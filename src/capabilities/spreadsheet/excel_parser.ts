import * as XLSX from "xlsx";
import type { SpreadsheetParseResult, SpreadsheetParser } from "./parser";

export class ExcelParser implements SpreadsheetParser {
	async parse(
		data: Uint8Array,
		_filename: string,
		_mimeType: string,
	): Promise<SpreadsheetParseResult> {
		try {
			const workbook = XLSX.read(data, {
				type: "array",
				cellDates: true,
				cellNF: true,
			});
			if (workbook.SheetNames.length === 0) {
				return {
					sheets: [
						{
							name: "Sheet1",
							headers: [],
							rows: [],
							rowCount: 0,
							colCount: 0,
						},
					],
					isEmpty: true,
					isCorrupt: false,
				};
			}

			const sheets = workbook.SheetNames.map((sheetName) => {
				const worksheet = workbook.Sheets[sheetName];
				const jsonData = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
					header: 1,
					defval: "",
				});
				const preferredData = this.preferFormulaCells(worksheet, jsonData);
				const nonEmptyRows = this.filterEmptyRows(preferredData);

				if (nonEmptyRows.length === 0) {
					return {
						name: sheetName,
						headers: [],
						rows: [] as string[][],
						rowCount: 0,
						colCount: 0,
					};
				}

				const headers = nonEmptyRows[0].map((h) => String(h).trim());
				const rows = nonEmptyRows.slice(1).map((row) =>
					row.map((cell) => {
						if (cell === null || cell === undefined) return "";
						if (typeof cell === "object" && "v" in cell) {
							const value = (cell as { v: unknown }).v;
							if (value instanceof Date)
								return value.toISOString().slice(0, 10);
							if (typeof value === "object" && value !== null)
								return JSON.stringify(value);
							return String(value).trim();
						}
						return String(cell).trim();
					}),
				);
				const filteredRows = rows.filter((row) =>
					row.some((cell) => cell !== ""),
				);

				return {
					name: sheetName,
					headers,
					rows: filteredRows,
					rowCount: filteredRows.length,
					colCount: headers.length,
				};
			});

			const allRowsEmpty = sheets.every((s) => s.rowCount === 0);

			return {
				sheets,
				isEmpty: allRowsEmpty,
				isCorrupt: false,
			};
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Unknown parse error";
			return {
				sheets: [
					{
						name: "Sheet1",
						headers: [],
						rows: [],
						rowCount: 0,
						colCount: 0,
					},
				],
				isEmpty: false,
				isCorrupt: true,
				errorMessage: message,
			};
		}
	}

	private filterEmptyRows(rows: unknown[][]): unknown[][] {
		return rows.filter((row) => {
			if (!Array.isArray(row)) return false;
			return row.some((cell) => {
				if (cell === null || cell === undefined) return false;
				if (typeof cell === "object" && "v" in cell)
					return (cell as { v: unknown }).v !== "";
				return String(cell).trim() !== "";
			});
		});
	}

	private preferFormulaCells(
		worksheet: XLSX.WorkSheet,
		rows: unknown[][],
	): unknown[][] {
		const ref = worksheet["!ref"];
		if (!ref) return rows;

		const range = XLSX.utils.decode_range(ref);
		const width = range.e.c - range.s.c + 1;

		return rows.map((row, rowIndex) => {
			const actualRow = range.s.r + rowIndex;
			return Array.from({ length: width }, (_unused, colIndex) => {
				const actualCol = range.s.c + colIndex;
				const address = XLSX.utils.encode_cell({ r: actualRow, c: actualCol });
				const worksheetCell = worksheet[address] as XLSX.CellObject | undefined;
				if (worksheetCell?.f) return `=${worksheetCell.f}`;
				return row[colIndex] ?? "";
			});
		});
	}
}
