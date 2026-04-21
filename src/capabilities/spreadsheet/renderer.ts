import type { SpreadsheetParseResult } from "./parser.js";

function plural(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function renderSpreadsheet(result: SpreadsheetParseResult, filename: string): string {
	const totalRowCount = result.sheets.reduce((sum, sheet) => sum + sheet.rowCount, 0);
	const totalColCount = result.sheets.reduce((max, sheet) => Math.max(max, sheet.colCount), 0);

	const header = `_Spreadsheet: ${filename} — ${plural(totalRowCount, "row", "rows")}, ${plural(totalColCount, "column", "columns")}_`;

	if (result.sheets.length === 1) {
		const sheet = result.sheets[0];
		const table = renderTable(sheet.headers, sheet.rows);
		return table ? `${header}\n\n${table}` : header;
	}

	const sheetsContent = result.sheets.map((sheet) => {
		const table = renderTable(sheet.headers, sheet.rows);
		return table ? `${sheet.name}\n${table}` : sheet.name;
	}).join("\n\n");

	return `${header}\n\n${sheetsContent}`;
}

function escapeCell(s: string): string {
	return s.replace(/\|/g, "\\|");
}

function renderTable(headers: string[], rows: string[][]): string {
	if (headers.length === 0 && rows.length === 0) {
		return "";
	}

	const headerRow = `| ${headers.map(escapeCell).join(" | ")} |`;
	const separatorRow = `| ${headers.map(() => "---").join(" | ")} |`;
	const dataRows = rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`);

	return [headerRow, separatorRow, ...dataRows].join("\n");
}