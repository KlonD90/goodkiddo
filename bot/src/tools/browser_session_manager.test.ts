import { describe, expect, test } from "bun:test";
import { createBrowserSessionManager } from "./browser_session_manager";
import type { CliRunner, ProcResult } from "./browser_tools";

function noop(): CliRunner {
	return async () => ({ stdout: "", stderr: "", exitCode: 0 } as ProcResult);
}

describe("BrowserSessionManager", () => {
	test("canIssue returns true when below cap", () => {
		const m = createBrowserSessionManager({ maxConcurrent: 3 });
		expect(m.canIssue()).toBe(true);
	});

	test("canIssue returns false when at cap", () => {
		const m = createBrowserSessionManager({ maxConcurrent: 2 });
		m.register("k1", "cli-k1");
		m.register("k2", "cli-k2");
		expect(m.canIssue()).toBe(false);
	});

	test("register increments count", () => {
		const m = createBrowserSessionManager();
		expect(m.count()).toBe(0);
		m.register("k1", "cli-k1");
		expect(m.count()).toBe(1);
	});

	test("isActive returns true for registered key, false for unknown", () => {
		const m = createBrowserSessionManager();
		m.register("k1", "cli-k1");
		expect(m.isActive("k1")).toBe(true);
		expect(m.isActive("k2")).toBe(false);
	});

	test("release removes session and decrements count", () => {
		const m = createBrowserSessionManager();
		m.register("k1", "cli-k1");
		m.release("k1");
		expect(m.count()).toBe(0);
		expect(m.isActive("k1")).toBe(false);
	});

	test("touch keeps session alive past idle threshold", async () => {
		const m = createBrowserSessionManager({ idleTimeoutMs: 50 });
		m.register("k1", "cli-k1");
		await new Promise((r) => setTimeout(r, 30));
		m.touch("k1");
		await new Promise((r) => setTimeout(r, 30));
		// Only 30ms since last touch — should NOT be reaped
		await m.reap(noop());
		expect(m.isActive("k1")).toBe(true);
	});

	test("reap removes sessions idle longer than threshold", async () => {
		const m = createBrowserSessionManager({ idleTimeoutMs: 20 });
		m.register("k1", "cli-k1");
		m.register("k2", "cli-k2");
		// touch k2 to keep it alive
		await new Promise((r) => setTimeout(r, 30));
		m.touch("k2");
		await m.reap(noop());
		expect(m.isActive("k1")).toBe(false);
		expect(m.isActive("k2")).toBe(true);
	});

	test("reap calls agent-browser close for reaped sessions", async () => {
		const calls: string[][] = [];
		const run: CliRunner = async (args) => {
			calls.push(args);
			return { stdout: "", stderr: "", exitCode: 0 };
		};
		const m = createBrowserSessionManager({ idleTimeoutMs: 10 });
		m.register("k1", "cli-session-1");
		await new Promise((r) => setTimeout(r, 20));
		await m.reap(run);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual(["--session", "cli-session-1", "close"]);
	});

	test("reap silently ignores CLI errors", async () => {
		const run: CliRunner = async () => {
			throw new Error("CLI not found");
		};
		const m = createBrowserSessionManager({ idleTimeoutMs: 10 });
		m.register("k1", "cli-k1");
		await new Promise((r) => setTimeout(r, 20));
		await expect(m.reap(run)).resolves.toBeUndefined();
		expect(m.isActive("k1")).toBe(false);
	});

	test("canIssue becomes true again after reap frees a slot", async () => {
		const m = createBrowserSessionManager({ maxConcurrent: 1, idleTimeoutMs: 10 });
		m.register("k1", "cli-k1");
		expect(m.canIssue()).toBe(false);
		await new Promise((r) => setTimeout(r, 20));
		await m.reap(noop());
		expect(m.canIssue()).toBe(true);
	});
});
