import { describe, expect, test } from "bun:test";
import {
	NoOpSpreadsheetParser,
	type SpreadsheetParser,
	type SpreadsheetParseResult,
} from "./parser";

class StubSpreadsheetParser implements SpreadsheetParser {
	async parse(_data: Uint8Array, _filename: string, _mimeType: string): Promise<SpreadsheetParseResult> {
		return {
			sheets: [
				{
					name: "Sheet1",
					headers: ["A", "B"],
					rows: [["1", "2"]],
					rowCount: 1,
					colCount: 2,
				},
			],
			isEmpty: false,
			isCorrupt: false,
		};
	}
}

describe("spreadsheet parser", () => {
	test("NoOpSpreadsheetParser throws when spreadsheet parsing is not configured", async () => {
		const parser = new NoOpSpreadsheetParser();

		expect(parser.parse(new Uint8Array([1, 2, 3]), "test.csv", "text/csv")).rejects.toThrow(
			/Spreadsheet parsing not configured/i,
		);
	});

	test("accepts implementations that satisfy the SpreadsheetParser contract", async () => {
		const parser: SpreadsheetParser = new StubSpreadsheetParser();

		const result = await parser.parse(new Uint8Array([1, 2, 3]), "test.csv", "text/csv");
		expect(result.sheets).toHaveLength(1);
		expect(result.sheets[0].name).toBe("Sheet1");
		expect(result.sheets[0].headers).toEqual(["A", "B"]);
		expect(result.sheets[0].rows).toEqual([["1", "2"]]);
		expect(result.sheets[0].rowCount).toBe(1);
		expect(result.sheets[0].colCount).toBe(2);
		expect(result.isEmpty).toBe(false);
		expect(result.isCorrupt).toBe(false);
	});
});