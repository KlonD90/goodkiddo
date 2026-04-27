import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import { readOrEmpty } from "./fs";
import { MEMORY_LOG_PATH } from "./layout";
import { appendLog, formatLogEntry, todayIso } from "./log";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

describe("formatLogEntry", () => {
	test("renders standard shape", () => {
		const entry = formatLogEntry("task_completed", "did a thing", "2026-04-16");
		expect(entry).toBe("## [2026-04-16] task_completed | did a thing\n");
	});

	test("flattens newlines in detail", () => {
		const entry = formatLogEntry("note", "line one\nline two", "2026-04-16");
		expect(entry).toBe("## [2026-04-16] note | line one line two\n");
	});

	test("replaces whitespace in op with underscores", () => {
		const entry = formatLogEntry("thread closed", "x", "2026-04-16");
		expect(entry).toBe("## [2026-04-16] thread_closed | x\n");
	});
});

describe("todayIso", () => {
	test("formats as YYYY-MM-DD", () => {
		const iso = todayIso(new Date(2026, 3, 16)); // Month is 0-based: 3 = April
		expect(iso).toBe("2026-04-16");
	});

	test("pads single-digit month and day", () => {
		const iso = todayIso(new Date(2026, 0, 5));
		expect(iso).toBe("2026-01-05");
	});
});

describe("appendLog", () => {
	test("creates log file when missing", async () => {
		const backend = createBackend("log-create");
		const entry = await appendLog(
			backend,
			"preference",
			"user likes terse replies",
			new Date(2026, 3, 16),
		);
		const content = await readOrEmpty(backend, MEMORY_LOG_PATH);
		expect(content).toContain("# Log");
		expect(content).toContain(entry.trim());
	});

	test("appends to existing log preserving order", async () => {
		const backend = createBackend("log-append");
		await appendLog(backend, "first", "one", new Date(2026, 3, 10));
		await appendLog(backend, "second", "two", new Date(2026, 3, 16));
		const content = await readOrEmpty(backend, MEMORY_LOG_PATH);
		const firstIdx = content.indexOf("first");
		const secondIdx = content.indexOf("second");
		expect(firstIdx).toBeGreaterThan(-1);
		expect(secondIdx).toBeGreaterThan(firstIdx);
	});
});
