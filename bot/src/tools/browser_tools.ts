import { randomUUID } from "node:crypto";
import { tool } from "langchain";
import { z } from "zod";
import type { BrowserSessionManager } from "./browser_session_manager";

// Thin wrapper around the `agent-browser` CLI. See:
// https://clawhub.ai/matrixy/agent-browser-clawdbot
// https://www.npmjs.com/package/agent-browser

const DEFAULT_SETTLE_MS = 250;
const ACTION_TIMEOUT_MS = 30_000;
const BINARY = "agent-browser";

export type ProcResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};
export type CliRunner = (args: string[]) => Promise<ProcResult>;

export interface SessionRegistry {
	issue(): string;
	has(key: string): boolean;
	/** Map a public key to the agent-browser --session name (on-disk scope). */
	resolve(key: string): string;
}

/** One registry per caller. Keys are opaque; the caller prefix isolates on-disk state. */
export function createSessionRegistry(callerId: string): SessionRegistry {
	const known = new Set<string>();
	const safeCaller = callerId.replace(/[^a-zA-Z0-9_-]/g, "_") || "shared";
	return {
		issue() {
			const key = `s-${randomUUID().slice(0, 8)}`;
			known.add(key);
			return key;
		},
		has(key) {
			return known.has(key);
		},
		resolve(key) {
			return `${safeCaller}-${key}`;
		},
	};
}

export interface BrowserToolOptions {
	run?: CliRunner;
	settleMs?: number;
	registry: SessionRegistry;
	manager?: BrowserSessionManager;
}

export async function defaultCliRunner(args: string[]): Promise<ProcResult> {
	const proc = Bun.spawn([BINARY, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const killer = setTimeout(() => proc.kill(), ACTION_TIMEOUT_MS);
	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		return { stdout, stderr, exitCode };
	} finally {
		clearTimeout(killer);
	}
}

async function getCurrentUrl(
	run: CliRunner,
	cliSession: string,
): Promise<string> {
	const { stdout, exitCode } = await run([
		"--session",
		cliSession,
		"get",
		"url",
	]);
	return exitCode === 0 ? stdout.trim() : "";
}

async function captureSnapshot(
	run: CliRunner,
	cliSession: string,
	selector?: string,
	interactiveOnly = false,
): Promise<string> {
	const args = ["--session", cliSession, "snapshot"];
	if (interactiveOnly) args.push("-i");
	if (selector) args.push("-s", selector);
	const { stdout, stderr, exitCode } = await run(args);
	if (exitCode !== 0) {
		return `snapshot error: ${stderr.trim() || stdout.trim() || "unknown"}`;
	}
	return stdout.trim();
}

const SNAPSHOT_DESCRIPTION = `Read the current browser page as an accessibility tree.

Each interactive element gets a ref like @e1, @e2, @e3 — these refs are how you target elements in browser_action.

Sessions:
- The first line of the response is 'session: <key>'. Pass that key back as 'sessionKey' in follow-up snapshot or action calls to continue in the same browser.
- To browse multiple things in parallel (e.g. compare 3 products, research multiple topics), call browser_snapshot again WITHOUT sessionKey. You will get a fresh browser and a new key to use independently.

Use when:
- Starting a task: pass a url to open the page and read it in one call
- After an action: to see what the page looks like now
- To find the ref for a specific button, link, or input you want to act on

Refs are local to each snapshot — a new snapshot gives new refs, so always snapshot before using refs.

Parameters:
- sessionKey (optional): key returned by a prior browser_snapshot. Omit to start a new browser.
- url (optional): navigate to this URL before snapshotting.
- selector (optional): CSS selector to scope the snapshot (use for modals, e.g. '[role=dialog]').
- interactiveOnly (optional, default false): full page text by default. Set true when you only need to find a button or input to act on and want a shorter response.

Full example — research a product on an SPA:

1. Start: browser_snapshot({ url: "https://shop.example.com" })
   → session: s-a1b2c3
     url: https://shop.example.com/
     heading "Shop"
     @e1 input "Search products"
     @e2 link "Electronics"

2. Search: browser_action({ sessionKey: "s-a1b2c3", action: "fill",
                            ref: "@e1", text: "headphones" })
   → session: s-a1b2c3
     ok — url unchanged

3. Read results: browser_snapshot({ sessionKey: "s-a1b2c3" })
   → session: s-a1b2c3
     url: https://shop.example.com/
     "127 results for headphones"
     @e1 input "Search products" = "headphones"
     @e2 link "Sony WH-1000XM5 — $349"
     @e3 link "Bose QC45 — $279"

4. Open detail: browser_action({ sessionKey: "s-a1b2c3", action: "click",
                                 ref: "@e2" })
   → session: s-a1b2c3
     ok — navigated to /p/sony-wh1000xm5

5. Read page: browser_snapshot({ sessionKey: "s-a1b2c3" })
   → full product description, specs, reviews…

Common mistakes to avoid:

- Reusing a ref from an older snapshot. Refs are valid only in the snapshot
  that returned them. If you take an action or a new snapshot, the refs may
  point to different elements. Always re-snapshot before re-using refs.

- Inventing a sessionKey. Never write your own key like "session-1". Only
  use the exact key returned by a prior browser_snapshot (they look like
  "s-a1b2c3"). Omit sessionKey to start a new one.

- Calling browser_action with action: "wait" right after click/fill. The
  tool already waits for the DOM to settle. Only wait manually when you
  need a specific text or JS condition to be true before continuing.

- Using interactiveOnly: true when reading content. The default (false)
  returns full page text. interactiveOnly: true strips everything except
  buttons/inputs/links — use it only when you already know what to click
  and want a shorter response.

- Mixing session keys across parallel tasks. If you're researching topic A
  and topic B in parallel, make sure each browser_action uses the key that
  belongs to that topic's snapshot.`;

const ACTION_DESCRIPTION = `Perform one action on the browser page: click, fill, scroll, wait, or back.

Refs come from a recent browser_snapshot. Always snapshot first to discover refs.

Actions and required params:
- click  — { action: "click", ref: "@e3", sessionKey }
- fill   — { action: "fill", ref: "@e1", text: "hello", sessionKey }
- scroll — { action: "scroll", direction: "down", amount: 500, sessionKey }
- wait   — { action: "wait", ms: 500, sessionKey }
           OR { action: "wait", until: "text to appear", sessionKey }
           OR { action: "wait", untilFn: "document.querySelector('.ready')", sessionKey }
- back   — { action: "back", sessionKey }

sessionKey is REQUIRED — it identifies which browser to act on. Use the key returned by the snapshot you are acting upon.

After click/fill/back the tool automatically waits for the DOM to settle. You usually do NOT need to call wait manually — only use it when a specific text or condition matters before you can continue.

Return value:
- On success: 'session: <key>\\nok' plus a short hint, e.g. 'ok — navigated to /orders' or 'ok — url unchanged'.
- On failure: the error, plus the current interactive refs so you can retry with a fresh ref.

Typical flow: snapshot → action → snapshot → action → …`;

function formatOutput(sessionKey: string, body: string): string {
	return `session: ${sessionKey}\n${body}`;
}

export function createBrowserSnapshotTool(options: BrowserToolOptions) {
	const run = options.run ?? defaultCliRunner;
	const { registry, manager } = options;
	return tool(
		async ({ url, selector, interactiveOnly, sessionKey }) => {
			let key: string;
			if (sessionKey) {
				if (!registry.has(sessionKey)) {
					return `error: unknown sessionKey '${sessionKey}'. Call browser_snapshot without sessionKey to start a new session.`;
				}
				if (manager && !manager.isActive(sessionKey)) {
					return `error: sessionKey '${sessionKey}' has expired due to inactivity. Call browser_snapshot without sessionKey to start a fresh session.`;
				}
				key = sessionKey;
			} else {
				if (manager && !manager.canIssue()) {
					return "error: browser session limit reached. All slots are in use — retry when a session finishes.";
				}
				key = registry.issue();
				manager?.register(key, registry.resolve(key));
			}
			const cliSession = registry.resolve(key);

			if (url) {
				const { exitCode, stderr, stdout } = await run([
					"--session",
					cliSession,
					"open",
					url,
				]);
				if (exitCode !== 0) {
					return formatOutput(
						key,
						`navigate failed: ${stderr.trim() || stdout.trim() || "unknown"}`,
					);
				}
			}
			const snap = await captureSnapshot(
				run,
				cliSession,
				selector,
				interactiveOnly ?? false,
			);
			const currentUrl = await getCurrentUrl(run, cliSession);
			const body = currentUrl ? `url: ${currentUrl}\n\n${snap}` : snap;
			manager?.touch(key);
			return formatOutput(key, body);
		},
		{
			name: "browser_snapshot",
			description: SNAPSHOT_DESCRIPTION,
			schema: z.object({
				sessionKey: z
					.string()
					.optional()
					.describe(
						"Session key from a prior snapshot. Omit to start a new session.",
					),
				url: z
					.string()
					.optional()
					.describe("Full URL to open before snapshotting"),
				selector: z
					.string()
					.optional()
					.describe("CSS selector to scope the snapshot"),
				interactiveOnly: z
					.boolean()
					.optional()
					.describe(
						"Trim to clickable/fillable elements only (default false — full page content)",
					),
			}),
		},
	);
}

const BrowserActionSchema = z.object({
	sessionKey: z.string().describe("Session key from a prior browser_snapshot"),
	action: z
		.enum(["click", "fill", "scroll", "wait", "back"])
		.describe("Which action to perform"),
	ref: z
		.string()
		.optional()
		.describe("Element ref from a recent snapshot, e.g. '@e3'"),
	text: z.string().optional().describe("Text to type (for fill)"),
	direction: z
		.enum(["up", "down"])
		.optional()
		.describe("Scroll direction (for scroll)"),
	amount: z
		.number()
		.optional()
		.describe("Scroll distance in pixels (for scroll)"),
	ms: z.number().optional().describe("Milliseconds to wait (for wait)"),
	until: z
		.string()
		.optional()
		.describe("Wait until this text appears on the page (for wait)"),
	untilFn: z
		.string()
		.optional()
		.describe("Wait until this JavaScript expression is truthy (for wait)"),
});

export function createBrowserActionTool(options: BrowserToolOptions) {
	const run = options.run ?? defaultCliRunner;
	const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
	const { registry, manager } = options;
	return tool(
		async (input) => {
			if (!registry.has(input.sessionKey)) {
				return `error: unknown sessionKey '${input.sessionKey}'. Call browser_snapshot first to get a valid session key.`;
			}
			if (manager && !manager.isActive(input.sessionKey)) {
				return `error: sessionKey '${input.sessionKey}' has expired due to inactivity. Call browser_snapshot without sessionKey to start a fresh session.`;
			}
			const cliSession = registry.resolve(input.sessionKey);
			const urlBefore = await getCurrentUrl(run, cliSession);

			let cmd: string[];
			switch (input.action) {
				case "click":
					if (!input.ref) {
						return formatOutput(
							input.sessionKey,
							"error: click requires a 'ref'",
						);
					}
					cmd = ["--session", cliSession, "click", input.ref];
					break;
				case "fill":
					if (!input.ref || input.text === undefined) {
						return formatOutput(
							input.sessionKey,
							"error: fill requires 'ref' and 'text'",
						);
					}
					cmd = ["--session", cliSession, "fill", input.ref, input.text];
					break;
				case "scroll":
					cmd = ["--session", cliSession, "scroll"];
					if (input.direction) cmd.push(`--${input.direction}`);
					if (input.amount !== undefined) {
						cmd.push("--amount", String(input.amount));
					}
					break;
				case "wait":
					cmd = ["--session", cliSession, "wait"];
					if (input.ms !== undefined) {
						cmd.push(String(input.ms));
					} else if (input.until) {
						cmd.push("--text", input.until);
					} else if (input.untilFn) {
						cmd.push("--fn", input.untilFn);
					} else {
						cmd.push("--load");
					}
					break;
				case "back":
					cmd = ["--session", cliSession, "back"];
					break;
			}

			const { stdout, stderr, exitCode } = await run(cmd);

			if (exitCode !== 0) {
				const mini = await captureSnapshot(run, cliSession, undefined, true);
				const msg = stderr.trim() || stdout.trim() || "unknown error";
				return formatOutput(
					input.sessionKey,
					`error: ${msg}\n\ncurrent interactive refs:\n${mini}`,
				);
			}

			const mutates =
				input.action === "click" ||
				input.action === "fill" ||
				input.action === "back";
			if (mutates) {
				await run([
					"--session",
					cliSession,
					"wait",
					"--fn",
					"document.readyState === 'complete'",
				]).catch(() => {});
				if (settleMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, settleMs));
				}
			}

			const urlAfter = await getCurrentUrl(run, cliSession);
			const hint =
				urlBefore && urlAfter && urlBefore !== urlAfter
					? ` — navigated to ${urlAfter}`
					: urlAfter
						? " — url unchanged"
						: "";
			manager?.touch(input.sessionKey);
			return formatOutput(input.sessionKey, `ok${hint}`);
		},
		{
			name: "browser_action",
			description: ACTION_DESCRIPTION,
			schema: BrowserActionSchema,
		},
	);
}
