import type { CliRunner } from "./browser_tools";

export interface BrowserSessionManager {
	canIssue(): boolean;
	register(key: string, cliSession: string): void;
	touch(key: string): void;
	release(key: string): void;
	isActive(key: string): boolean;
	reap(run: CliRunner): Promise<void>;
	count(): number;
}

export interface BrowserSessionManagerOptions {
	maxConcurrent?: number;
	idleTimeoutMs?: number;
}

interface SessionEntry {
	cliSession: string;
	lastActiveAt: number;
}

export function createBrowserSessionManager(
	options: BrowserSessionManagerOptions = {},
): BrowserSessionManager {
	const maxConcurrent = options.maxConcurrent ?? 8;
	const idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
	const sessions = new Map<string, SessionEntry>();

	return {
		canIssue() {
			return sessions.size < maxConcurrent;
		},
		register(key, cliSession) {
			sessions.set(key, { cliSession, lastActiveAt: Date.now() });
		},
		touch(key) {
			const entry = sessions.get(key);
			if (entry) entry.lastActiveAt = Date.now();
		},
		release(key) {
			sessions.delete(key);
		},
		isActive(key) {
			return sessions.has(key);
		},
		async reap(run) {
			const now = Date.now();
			const expired: [string, SessionEntry][] = [];
			for (const [key, entry] of sessions) {
				if (now - entry.lastActiveAt > idleTimeoutMs) {
					expired.push([key, entry]);
				}
			}
			await Promise.all(
				expired.map(async ([key, entry]) => {
					sessions.delete(key);
					await run(["--session", entry.cliSession, "close"]).catch(() => {});
				}),
			);
		},
		count() {
			return sessions.size;
		},
	};
}
