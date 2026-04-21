import { describe, expect, test } from "bun:test";
import { PDF_MAX_BYTES } from "./constants";

describe("pdf constants", () => {
	test("define the supported Telegram PDF constraints", () => {
		expect(PDF_MAX_BYTES).toBe(20 * 1024 * 1024);
	});
});