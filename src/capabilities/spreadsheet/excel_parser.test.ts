import { describe, expect, test } from "bun:test";
import { ExcelParser } from "./excel_parser";
import * as XLSX from "xlsx";

describe("ExcelParser", () => {
	const parser = new ExcelParser();

	function createExcelBuffer(data: string[][][], sheetNames: string[]): Uint8Array {
		const wb = XLSX.utils.book_new();
		data.forEach((sheetData, index) => {
			const ws = XLSX.utils.aoa_to_sheet(sheetData);
			XLSX.utils.book_append_sheet(wb, ws, sheetNames[index] || `Sheet${index + 1}`);
		});
		const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
		return new Uint8Array(wbout);
	}

	test("parses valid single-sheet Excel file", async () => {
		const data = [["name", "age", "city"], ["Alice", "30", "NYC"], ["Bob", "25", "LA"]];
		const buffer = createExcelBuffer([data], ["Sheet1"]);
		const result = await parser.parse(buffer, "test.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		expect(result.isCorrupt).toBe(false);
		expect(result.isEmpty).toBe(false);
		expect(result.sheets.length).toBe(1);
		expect(result.sheets[0].name).toBe("Sheet1");
		expect(result.sheets[0].headers).toEqual(["name", "age", "city"]);
		expect(result.sheets[0].rows).toEqual([["Alice", "30", "NYC"], ["Bob", "25", "LA"]]);
		expect(result.sheets[0].rowCount).toBe(2);
		expect(result.sheets[0].colCount).toBe(3);
	});

	test("parses multi-sheet Excel file", async () => {
		const sheet1 = [["name", "city"], ["Alice", "NYC"]];
		const sheet2 = [["product", "price"], ["Apple", "1.5"]];
		const buffer = createExcelBuffer([sheet1, sheet2], ["Users", "Products"]);
		const result = await parser.parse(buffer, "multi.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		expect(result.isCorrupt).toBe(false);
		expect(result.sheets.length).toBe(2);
		expect(result.sheets[0].name).toBe("Users");
		expect(result.sheets[1].name).toBe("Products");
		expect(result.sheets[0].rowCount).toBe(1);
		expect(result.sheets[1].rowCount).toBe(1);
	});

	test("handles empty Excel file", async () => {
		const buffer = createExcelBuffer([[]], ["Empty"]);
		const result = await parser.parse(buffer, "empty.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		expect(result.isEmpty).toBe(true);
		expect(result.isCorrupt).toBe(false);
	});

	test("marks corrupt file on invalid Excel data", async () => {
		const invalidData = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
		const result = await parser.parse(invalidData, "corrupt.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		expect(result.isCorrupt).toBe(true);
	});

	test("skips completely empty rows", async () => {
		const data = [["name", "age"], ["Alice", "30"], [], ["Bob", "25"], []];
		const buffer = createExcelBuffer([data], ["Data"]);
		const result = await parser.parse(buffer, "empty_rows.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		expect(result.sheets[0].rowCount).toBe(2);
	});

	test("handles .xls format (application/vnd.ms-excel)", async () => {
		const data = [["name", "value"], ["Test", "123"]];
		const buffer = createExcelBuffer([data], ["Sheet1"]);
		const result = await parser.parse(buffer, "test.xls", "application/vnd.ms-excel");
		expect(result.isCorrupt).toBe(false);
		expect(result.sheets[0].rowCount).toBe(1);
	});

	test("trims whitespace from cells", async () => {
		const data = [["  name  ", "  age  "], ["  Alice  ", "  30  "]];
		const buffer = createExcelBuffer([data], ["Data"]);
		const result = await parser.parse(buffer, "whitespace.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		expect(result.sheets[0].headers).toEqual(["name", "age"]);
		expect(result.sheets[0].rows[0]).toEqual(["Alice", "30"]);
	});

	test("prefers formulas over cached values", async () => {
		const wb = XLSX.utils.book_new();
		const ws = XLSX.utils.aoa_to_sheet([["left", "right", "sum"], [1, 2, null]]);
		ws.C2 = { t: "n", f: "A2+B2", v: 3 };
		XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

		const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
		const result = await parser.parse(
			new Uint8Array(wbout),
			"formula.xlsx",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
		);

		expect(result.isCorrupt).toBe(false);
		expect(result.sheets[0].rows).toEqual([["1", "2", "=A2+B2"]]);
	});
});
