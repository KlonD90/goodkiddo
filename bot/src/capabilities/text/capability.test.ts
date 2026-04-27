import { describe, expect, test } from "bun:test";
import { canHandleTextFile, createTextFileCapability } from "./capability";

const capability = createTextFileCapability();
const enc = (s: string) => new TextEncoder().encode(s);

describe("canHandleTextFile", () => {
	test("accepts text/plain mime", () => {
		expect(canHandleTextFile({ mimeType: "text/plain" })).toBe(true);
	});

	test("accepts text/markdown mime", () => {
		expect(canHandleTextFile({ mimeType: "text/markdown" })).toBe(true);
	});

	test("accepts text/x-python mime", () => {
		expect(canHandleTextFile({ mimeType: "text/x-python" })).toBe(true);
	});

	test("accepts application/json mime", () => {
		expect(canHandleTextFile({ mimeType: "application/json" })).toBe(true);
	});

	test("accepts application/javascript mime", () => {
		expect(canHandleTextFile({ mimeType: "application/javascript" })).toBe(true);
	});

	test("accepts application/typescript mime", () => {
		expect(canHandleTextFile({ mimeType: "application/typescript" })).toBe(true);
	});

	test("accepts mime with charset suffix", () => {
		expect(canHandleTextFile({ mimeType: "text/plain; charset=utf-8" })).toBe(true);
	});

	test("accepts .js extension", () => {
		expect(canHandleTextFile({ filename: "app.js" })).toBe(true);
	});

	test("accepts .ts extension", () => {
		expect(canHandleTextFile({ filename: "index.ts" })).toBe(true);
	});

	test("accepts .json extension", () => {
		expect(canHandleTextFile({ filename: "package.json" })).toBe(true);
	});

	test("accepts .py extension", () => {
		expect(canHandleTextFile({ filename: "script.py" })).toBe(true);
	});

	test("accepts .md extension", () => {
		expect(canHandleTextFile({ filename: "README.md" })).toBe(true);
	});

	test("accepts .sql extension", () => {
		expect(canHandleTextFile({ filename: "schema.sql" })).toBe(true);
	});

	test("accepts Dockerfile bare name", () => {
		expect(canHandleTextFile({ filename: "Dockerfile" })).toBe(true);
	});

	test("rejects application/pdf", () => {
		expect(canHandleTextFile({ mimeType: "application/pdf" })).toBe(false);
	});

	test("rejects image/png", () => {
		expect(canHandleTextFile({ mimeType: "image/png" })).toBe(false);
	});

	test("rejects .pdf extension", () => {
		expect(canHandleTextFile({ filename: "doc.pdf" })).toBe(false);
	});

	test("rejects .zip extension", () => {
		expect(canHandleTextFile({ filename: "archive.zip" })).toBe(false);
	});

	test("rejects empty metadata", () => {
		expect(canHandleTextFile({})).toBe(false);
	});
});

describe("createTextFileCapability — prevalidate", () => {
	test("passes when size is under limit", () => {
		expect(capability.prevalidate?.({ byteSize: 1000 })).toBeNull();
	});

	test("rejects when size exceeds 512 KB", () => {
		const result = capability.prevalidate?.({ byteSize: 600 * 1024 });
		expect(result?.ok).toBe(false);
	});

	test("passes when size is undefined", () => {
		expect(capability.prevalidate?.({})).toBeNull();
	});
});

describe("createTextFileCapability — process", () => {
	test("wraps content in File tags", async () => {
		const result = await capability.process({
			bytes: enc("const x = 1;"),
			metadata: { filename: "app.js" },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.content).toBe("[File: app.js]\nconst x = 1;\n[/File: app.js]");
	});

	test("includes caption when present", async () => {
		const result = await capability.process({
			bytes: enc("{}"),
			metadata: { filename: "config.json", caption: "my config" },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.content).toContain('Caption: "my config"');
		expect(result.value.currentUserText).toBe("my config");
		expect(result.value.commandText).toBe("my config");
	});

	test("uses fallback filename when absent", async () => {
		const result = await capability.process({
			bytes: enc("hello"),
			metadata: {},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.content).toContain("[File: file.txt]");
	});

	test("rejects non-UTF-8 bytes", async () => {
		const result = await capability.process({
			bytes: new Uint8Array([0xff, 0xfe, 0x00]),
			metadata: { filename: "bad.txt" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.userMessage).toContain("UTF-8");
	});

	test("currentUserText is filename when no caption", async () => {
		const result = await capability.process({
			bytes: enc("select 1"),
			metadata: { filename: "query.sql" },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.currentUserText).toBe("User attached query.sql");
	});
});
