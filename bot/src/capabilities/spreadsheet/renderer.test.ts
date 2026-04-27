import { describe, expect, test } from "bun:test";
import { renderSpreadsheet } from "./renderer";
import type { SpreadsheetParseResult } from "./parser";

describe("renderSpreadsheet", () => {
	test("renders single sheet as markdown table", () => {
		const result: SpreadsheetParseResult = {
			sheets: [{
				name: "Sheet1",
				headers: ["Name", "Age"],
				rows: [["Alice", "30"], ["Bob", "25"]],
				rowCount: 2,
				colCount: 2
			}],
			isEmpty: false,
			isCorrupt: false
		};

		const output = renderSpreadsheet(result, "test.csv");
		expect(output).toBe(`_Spreadsheet: test.csv — 2 rows, 2 columns_

| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`);
	});

	test("renders multi-sheet spreadsheet with sheet name headers", () => {
		const result: SpreadsheetParseResult = {
			sheets: [
				{
					name: "Users",
					headers: ["Name", "Age"],
					rows: [["Alice", "30"]],
					rowCount: 1,
					colCount: 2
				},
				{
					name: "Products",
					headers: ["Product", "Price"],
					rows: [["Apple", "1.5"]],
					rowCount: 1,
					colCount: 2
				}
			],
			isEmpty: false,
			isCorrupt: false
		};

		const output = renderSpreadsheet(result, "data.xlsx");
		expect(output).toBe(`_Spreadsheet: data.xlsx — 2 rows, 2 columns_

Users
| Name | Age |
| --- | --- |
| Alice | 30 |

Products
| Product | Price |
| --- | --- |
| Apple | 1.5 |`);
	});

	test("renders empty spreadsheet", () => {
		const result: SpreadsheetParseResult = {
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

		const output = renderSpreadsheet(result, "empty.csv");
		expect(output).toBe(`_Spreadsheet: empty.csv — 0 rows, 0 columns_`);
	});

	test("handles single sheet without sheet name header", () => {
		const result: SpreadsheetParseResult = {
			sheets: [{
				name: "Data",
				headers: ["A"],
				rows: [["1"]],
				rowCount: 1,
				colCount: 1
			}],
			isEmpty: false,
			isCorrupt: false
		};

		const output = renderSpreadsheet(result, "single.csv");
		expect(output).not.toContain("Data\n|");
		expect(output).toContain("_Spreadsheet: single.csv — 1 row, 1 column_");
		expect(output).toContain("| A |");
	});

	test("calculates total row count across multiple sheets", () => {
		const result: SpreadsheetParseResult = {
			sheets: [
				{ name: "S1", headers: ["A"], rows: [["1"], ["2"]], rowCount: 2, colCount: 1 },
				{ name: "S2", headers: ["B"], rows: [["3"]], rowCount: 1, colCount: 1 }
			],
			isEmpty: false,
			isCorrupt: false
		};

		const output = renderSpreadsheet(result, "multi.xlsx");
		expect(output).toContain("_Spreadsheet: multi.xlsx — 3 rows,");
	});

	test("uses max column count across sheets", () => {
		const result: SpreadsheetParseResult = {
			sheets: [
				{ name: "S1", headers: ["A", "B"], rows: [["1", "2"]], rowCount: 1, colCount: 2 },
				{ name: "S2", headers: ["C"], rows: [["3"]], rowCount: 1, colCount: 1 }
			],
			isEmpty: false,
			isCorrupt: false
		};

		const output = renderSpreadsheet(result, "mixed.xlsx");
		expect(output).toContain("_Spreadsheet: mixed.xlsx — 2 rows, 2 columns_");
	});
});