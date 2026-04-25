import { describe, expect, test } from "bun:test";
import { CsvParser } from "./csv_parser";

describe("CsvParser", () => {
	const parser = new CsvParser();

	test("parses valid CSV with comma delimiter", async () => {
		const csv = "name,age,city\nAlice,30,NYC\nBob,25,LA";
		const data = new TextEncoder().encode(csv);
		const result = await parser.parse(data, "test.csv", "text/csv");
		expect(result.isCorrupt).toBe(false);
		expect(result.isEmpty).toBe(false);
		expect(result.sheets.length).toBe(1);
		expect(result.sheets[0].name).toBe("Sheet1");
		expect(result.sheets[0].headers).toEqual(["name", "age", "city"]);
		expect(result.sheets[0].rows).toEqual([["Alice", "30", "NYC"], ["Bob", "25", "LA"]]);
		expect(result.sheets[0].rowCount).toBe(2);
		expect(result.sheets[0].colCount).toBe(3);
	});

	test("parses CSV with semicolon delimiter", async () => {
		const csv = "name;age;city\nAlice;30;NYC\nBob;25;LA";
		const data = new TextEncoder().encode(csv);
		const result = await parser.parse(data, "test.csv", "text/csv");
		expect(result.isCorrupt).toBe(false);
		expect(result.sheets[0].headers).toEqual(["name", "age", "city"]);
		expect(result.sheets[0].rows).toEqual([["Alice", "30", "NYC"], ["Bob", "25", "LA"]]);
	});

	test("parses CSV with tab delimiter", async () => {
		const csv = "name\tage\tcity\nAlice\t30\tNYC\nBob\t25\tLA";
		const data = new TextEncoder().encode(csv);
		const result = await parser.parse(data, "test.csv", "text/csv");
		expect(result.isCorrupt).toBe(false);
		expect(result.sheets[0].headers).toEqual(["name", "age", "city"]);
	});

	test("parses CSV with quoted fields", async () => {
		const csv = 'name,city\n"Alice Smith","New York, NY"\n"Bob ""Bobby"" Jones",LA';
		const data = new TextEncoder().encode(csv);
		const result = await parser.parse(data, "test.csv", "text/csv");
		expect(result.isCorrupt).toBe(false);
		expect(result.sheets[0].headers).toEqual(["name", "city"]);
		expect(result.sheets[0].rows[0]).toEqual(["Alice Smith", "New York, NY"]);
		expect(result.sheets[0].rows[1]).toEqual(['Bob "Bobby" Jones', "LA"]);
	});

	test("handles empty CSV", async () => {
		const csv = "";
		const data = new TextEncoder().encode(csv);
		const result = await parser.parse(data, "empty.csv", "text/csv");
		expect(result.isEmpty).toBe(true);
		expect(result.isCorrupt).toBe(false);
	});

	test("handles CSV with only headers", async () => {
		const csv = "name,age,city";
		const data = new TextEncoder().encode(csv);
		const result = await parser.parse(data, "headers_only.csv", "text/csv");
		expect(result.isEmpty).toBe(true);
		expect(result.sheets[0].rowCount).toBe(0);
	});

	test("marks corrupt file on invalid CSV syntax", async () => {
		const csv = 'name,city\n"unclosed quote';
		const data = new TextEncoder().encode(csv);
		const result = await parser.parse(data, "corrupt.csv", "text/csv");
		expect(result.isCorrupt).toBe(true);
	});

	test("trims whitespace from cells", async () => {
		const csv = "  name  ,  age  ,  city  \n  Alice  ,  30  ,  NYC  ";
		const data = new TextEncoder().encode(csv);
		const result = await parser.parse(data, "whitespace.csv", "text/csv");
		expect(result.sheets[0].headers).toEqual(["name", "age", "city"]);
		expect(result.sheets[0].rows[0]).toEqual(["Alice", "30", "NYC"]);
	});

	test("skips completely empty rows", async () => {
		const csv = "name,age\nAlice,30\n\nBob,25\n";
		const data = new TextEncoder().encode(csv);
		const result = await parser.parse(data, "empty_rows.csv", "text/csv");
		expect(result.sheets[0].rowCount).toBe(2);
	});
});