import { describe, expect, test } from "bun:test";
import { decodeBase64Utf8 } from "./text";

describe("decodeBase64Utf8", () => {
	test("decodes UTF-8 text instead of Latin-1 binary strings", () => {
		const text = "Текущая дата: Asia/Bangkok";
		const base64 = Buffer.from(text, "utf8").toString("base64");

		expect(decodeBase64Utf8(base64)).toBe(text);
	});
});
