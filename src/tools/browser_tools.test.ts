import { describe, expect, test } from "bun:test";
import {
	type CliRunner,
	createBrowserActionTool,
	createBrowserSnapshotTool,
	createSessionRegistry,
	type ProcResult,
} from "./browser_tools";

type Invokable = { invoke: (input: unknown) => Promise<string> };

async function callTool(tool: unknown, input: unknown): Promise<string> {
	return (tool as Invokable).invoke(input);
}

type StubResponse = ProcResult | ((args: string[]) => ProcResult);

function ok(stdout = ""): ProcResult {
	return { stdout, stderr: "", exitCode: 0 };
}
function fail(stderr: string, exitCode = 1): ProcResult {
	return { stdout: "", stderr, exitCode };
}

function makeRunner(
	responders: Record<string, StubResponse>,
	calls: string[][] = [],
): CliRunner {
	return async (args) => {
		calls.push(args);
		const verb = args[2] ?? "";
		const responder = responders[verb];
		if (!responder) {
			throw new Error(`no stub for verb "${verb}": ${args.join(" ")}`);
		}
		return typeof responder === "function" ? responder(args) : responder;
	};
}

function extractSessionKey(output: string): string {
	const match = output.match(/^session: (\S+)/);
	if (!match) throw new Error(`no session key in output: ${output}`);
	return match[1];
}

describe("browser_snapshot", () => {
	test("issues a new key on first call, returns it in output", async () => {
		const calls: string[][] = [];
		const run = makeRunner(
			{
				open: ok(""),
				snapshot: ok("@e1 link 'Orders'"),
				get: ok("https://app.example.com/dashboard"),
			},
			calls,
		);
		const registry = createSessionRegistry("user-42");

		const tool = createBrowserSnapshotTool({ run, registry });
		const result = await callTool(tool, {
			url: "https://app.example.com",
		});

		const key = extractSessionKey(result);
		expect(key).toMatch(/^s-[0-9a-f]+$/);
		expect(registry.has(key)).toBe(true);
		expect(result).toContain("url: https://app.example.com/dashboard");
		expect(result).toContain("@e1 link 'Orders'");

		// CLI --session uses caller-prefixed name for on-disk isolation
		const cliSession = registry.resolve(key);
		expect(cliSession).toBe(`user-42-${key}`);
		expect(calls[0]).toEqual([
			"--session",
			cliSession,
			"open",
			"https://app.example.com",
		]);
	});

	test("reuses browser when sessionKey provided", async () => {
		const calls: string[][] = [];
		const run = makeRunner(
			{
				snapshot: ok("content"),
				get: ok("https://app.example.com/x"),
			},
			calls,
		);
		const registry = createSessionRegistry("u");
		const tool = createBrowserSnapshotTool({ run, registry });

		const first = await callTool(tool, {});
		const key = extractSessionKey(first);

		calls.length = 0;
		const second = await callTool(tool, { sessionKey: key });
		expect(extractSessionKey(second)).toBe(key);
		// No new key issued
		expect(calls[0][1]).toBe(registry.resolve(key));
	});

	test("rejects unknown sessionKey", async () => {
		const registry = createSessionRegistry("u");
		const run = makeRunner({}); // nothing should be called
		const tool = createBrowserSnapshotTool({ run, registry });

		const result = await callTool(tool, { sessionKey: "s-bogus" });
		expect(result).toContain("error: unknown sessionKey 's-bogus'");
	});

	test("parallel snapshots without key get distinct keys and CLI sessions", async () => {
		const run = makeRunner({
			open: ok(""),
			snapshot: ok("content"),
			get: ok("https://x/"),
		});
		const registry = createSessionRegistry("u");
		const tool = createBrowserSnapshotTool({ run, registry });

		const [r1, r2, r3] = await Promise.all([
			callTool(tool, { url: "https://a/" }),
			callTool(tool, { url: "https://b/" }),
			callTool(tool, { url: "https://c/" }),
		]);
		const keys = [r1, r2, r3].map(extractSessionKey);
		expect(new Set(keys).size).toBe(3);
		for (const k of keys) expect(registry.has(k)).toBe(true);
	});

	test("two callers cannot share keys (separate registries)", async () => {
		const run = makeRunner({
			snapshot: ok("content"),
			get: ok("https://x/"),
		});
		const regA = createSessionRegistry("alice");
		const regB = createSessionRegistry("bob");
		const toolA = createBrowserSnapshotTool({ run, registry: regA });
		const toolB = createBrowserSnapshotTool({ run, registry: regB });

		const keyA = extractSessionKey(await callTool(toolA, {}));
		expect(regA.has(keyA)).toBe(true);
		expect(regB.has(keyA)).toBe(false);

		// Bob tries to use Alice's key → rejected
		const result = await callTool(toolB, { sessionKey: keyA });
		expect(result).toContain("error: unknown sessionKey");
	});

	test("snapshot defaults to full content (no -i); opts in when interactiveOnly=true", async () => {
		const calls: string[][] = [];
		const run = makeRunner(
			{ snapshot: ok("full page text"), get: ok("https://x/") },
			calls,
		);
		const registry = createSessionRegistry("u");
		const tool = createBrowserSnapshotTool({ run, registry });

		await callTool(tool, {});
		expect(calls[0].includes("-i")).toBe(false);

		calls.length = 0;
		const first = await callTool(tool, {});
		const key = extractSessionKey(first);
		calls.length = 0;
		await callTool(tool, { sessionKey: key, interactiveOnly: true });
		expect(calls[0].includes("-i")).toBe(true);
	});

	test("returns navigate error prefixed with session key", async () => {
		const run = makeRunner({
			open: fail("connection refused"),
		});
		const registry = createSessionRegistry("u");
		const tool = createBrowserSnapshotTool({ run, registry });

		const result = await callTool(tool, { url: "https://bad/" });
		expect(result).toMatch(/^session: s-/);
		expect(result).toContain("navigate failed");
	});
});

describe("browser_action", () => {
	async function setup(
		responders: Record<string, StubResponse>,
		calls: string[][] = [],
	) {
		const run = makeRunner(
			{ snapshot: ok(""), get: ok("https://x/"), ...responders },
			calls,
		);
		const registry = createSessionRegistry("u");
		const snapshotTool = createBrowserSnapshotTool({ run, registry });
		const actionTool = createBrowserActionTool({
			run,
			registry,
			settleMs: 0,
		});
		const firstSnap = await callTool(snapshotTool, {});
		const sessionKey = extractSessionKey(firstSnap);
		calls.length = 0;
		return { run, registry, actionTool, sessionKey, calls };
	}

	test("click assembles command, auto-settles, echoes key, reports navigation", async () => {
		const calls: string[][] = [];
		// setup's initial snapshot consumes the first url; action reads before + after
		const urls = ["https://x/init", "https://x/a", "https://x/b"];
		const { actionTool, sessionKey, registry } = await setup(
			{
				get: () => ok(urls.shift() ?? ""),
				click: ok(""),
				wait: ok(""),
			},
			calls,
		);
		const result = await callTool(actionTool, {
			sessionKey,
			action: "click",
			ref: "@e3",
		});

		const verbs = calls.map((c) => c[2]);
		expect(verbs).toEqual(["get", "click", "wait", "get"]);
		expect(calls[1]).toEqual([
			"--session",
			registry.resolve(sessionKey),
			"click",
			"@e3",
		]);
		expect(result).toBe(
			`session: ${sessionKey}\nok — navigated to https://x/b`,
		);
	});

	test("fill passes text; url unchanged reported", async () => {
		const calls: string[][] = [];
		const { actionTool, sessionKey } = await setup(
			{ fill: ok(""), wait: ok("") },
			calls,
		);
		const result = await callTool(actionTool, {
			sessionKey,
			action: "fill",
			ref: "@e1",
			text: "4821",
		});
		expect(calls[1][2]).toBe("fill");
		expect(calls[1][3]).toBe("@e1");
		expect(calls[1][4]).toBe("4821");
		expect(result).toBe(`session: ${sessionKey}\nok — url unchanged`);
	});

	test("wait variants produce correct flags and skip auto-settle", async () => {
		for (const [input, tail] of [
			[{ ms: 500 }, ["wait", "500"]],
			[{ until: "Loaded" }, ["wait", "--text", "Loaded"]],
			[{ untilFn: "document.body" }, ["wait", "--fn", "document.body"]],
			[{}, ["wait", "--load"]],
		] as const) {
			const calls: string[][] = [];
			const { actionTool, sessionKey } = await setup({ wait: ok("") }, calls);
			await callTool(actionTool, {
				sessionKey,
				action: "wait",
				...input,
			});
			// one get, one wait, one get — no auto-settle wait
			const verbs = calls.map((c) => c[2]);
			expect(verbs).toEqual(["get", "wait", "get"]);
			expect(calls[1].slice(2)).toEqual(tail as unknown as string[]);
		}
	});

	test("scroll assembles direction and amount", async () => {
		const calls: string[][] = [];
		const { actionTool, sessionKey } = await setup({ scroll: ok("") }, calls);
		await callTool(actionTool, {
			sessionKey,
			action: "scroll",
			direction: "down",
			amount: 500,
		});
		expect(calls[1].slice(2)).toEqual(["scroll", "--down", "--amount", "500"]);
	});

	test("error path returns mini-snapshot of current refs", async () => {
		const { actionTool, sessionKey, run, registry } = await setup({
			click: fail("ref @e3 not found"),
			snapshot: ok("@e7 button 'New ref'"),
		});
		// swap in refreshed runner behavior not needed; re-use setup

		const result = await callTool(actionTool, {
			sessionKey,
			action: "click",
			ref: "@e3",
		});
		expect(result).toContain(`session: ${sessionKey}`);
		expect(result).toContain("error: ref @e3 not found");
		expect(result).toContain("current interactive refs:");
		expect(result).toContain("@e7 button 'New ref'");
		// Ensure we're using the same CLI session
		void run;
		void registry;
	});

	test("click without ref short-circuits", async () => {
		const { actionTool, sessionKey } = await setup({});
		const result = await callTool(actionTool, {
			sessionKey,
			action: "click",
		});
		expect(result).toBe(
			`session: ${sessionKey}\nerror: click requires a 'ref'`,
		);
	});

	test("rejects unknown sessionKey before touching CLI", async () => {
		const calls: string[][] = [];
		const run = makeRunner({}, calls);
		const registry = createSessionRegistry("u");
		const actionTool = createBrowserActionTool({
			run,
			registry,
			settleMs: 0,
		});
		const result = await callTool(actionTool, {
			sessionKey: "s-bogus",
			action: "click",
			ref: "@e1",
		});
		expect(result).toContain("error: unknown sessionKey 's-bogus'");
		expect(calls).toHaveLength(0);
	});
});
