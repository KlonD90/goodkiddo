import type { BackendProtocol } from "deepagents";
import { append, exists, overwrite } from "./fs";
import { MEMORY_LOG_PATH } from "./layout";

// log.md captures chronological events. Shape per Karpathy:
//
//   ## [YYYY-MM-DD] op | detail
//
// Multi-line details are fine — indent continuations are discouraged, write
// each on its own line after the header. The `## [YYYY-` prefix is what the
// agent (or lint) parses.

export function formatLogEntry(
	op: string,
	detail: string,
	date: string,
): string {
	const cleanOp = op.trim().replace(/\s+/g, "_");
	const cleanDetail = detail.trim().replace(/\n/g, " ");
	return `## [${date}] ${cleanOp} | ${cleanDetail}\n`;
}

export function todayIso(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export async function appendLog(
	backend: BackendProtocol,
	op: string,
	detail: string,
	now: Date = new Date(),
): Promise<string> {
	const entry = formatLogEntry(op, detail, todayIso(now));
	if (await exists(backend, MEMORY_LOG_PATH)) {
		await append(backend, MEMORY_LOG_PATH, entry);
	} else {
		await overwrite(backend, MEMORY_LOG_PATH, `# Log\n\n${entry}`);
	}
	return entry;
}
