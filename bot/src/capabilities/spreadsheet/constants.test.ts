import { describe, expect, test } from "bun:test";
import { SPREADSHEET_MAX_BYTES } from "./constants";

describe("spreadsheet constants", () => {
	test("SPREADSHEET_MAX_BYTES is 10 MB", () => {
		expect(SPREADSHEET_MAX_BYTES).toBe(10 * 1024 * 1024);
	});
});