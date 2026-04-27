import type { BackendProtocol, FileInfo } from "deepagents";
import { currentActuel } from "./actuel_archive";
import { readOrEmpty } from "./fs";
import { readIndexFile } from "./index_manager";
import {
	LINT_OVER_BUDGET_RATIO,
	LINT_STALE_DAYS,
	MEMORY_INDEX_PATH,
	MEMORY_PROMPT_CHAR_CAP,
	NOTES_DIR,
	SKILLS_INDEX_PATH,
	SKILLS_ROOT,
	USER_PROFILE_PATH,
} from "./layout";

// Matches the seeded placeholder from bootstrap.ts. Anything else — even a
// single fact — means the profile has been populated and we stop nudging.
const USER_PROFILE_PLACEHOLDER =
	"_No profile yet. Populate as you learn about the user._";

// Pure-function health check over the memory subtrees. Findings surface to the
// agent via the `## Memory maintenance` block appended to the system prompt by
// session_loader — never as a tool the LLM can call. Keeping it implicit means
// the agent can't avoid or game it, and it costs zero tokens when the store is
// clean.

export type LintFindings = {
	staleNotes: string[]; // paths of files with mtime older than LINT_STALE_DAYS
	orphans: string[]; // files present on disk but not in the index
	duplicates: string[]; // slugs appearing more than once in an index
	overBudget: { memoryChars: number; skillsChars: number } | null;
	userProfileEmpty: boolean; // USER.md still holds the bootstrap placeholder
};

export function isEmpty(findings: LintFindings): boolean {
	return (
		findings.staleNotes.length === 0 &&
		findings.orphans.length === 0 &&
		findings.duplicates.length === 0 &&
		findings.overBudget === null &&
		!findings.userProfileEmpty
	);
}

function msSince(iso: string | undefined, now: number): number {
	if (!iso) return 0;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return 0;
	return now - t;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function listFiles(
	backend: BackendProtocol,
	dir: string,
): Promise<FileInfo[]> {
	try {
		const infos = await backend.lsInfo(dir);
		return infos.filter((info) => !info.is_dir);
	} catch {
		return [];
	}
}

function findDuplicateSlugs(entries: { slug: string }[]): string[] {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		counts.set(entry.slug, (counts.get(entry.slug) ?? 0) + 1);
	}
	return [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([slug]) => slug);
}

export async function runLint(
	backend: BackendProtocol,
	now: Date = new Date(),
): Promise<LintFindings> {
	const nowMs = now.getTime();
	const staleThreshold = LINT_STALE_DAYS * DAY_MS;

	const [memoryIndex, skillsIndex, noteFiles, skillFiles] = await Promise.all([
		readIndexFile(backend, MEMORY_INDEX_PATH),
		readIndexFile(backend, SKILLS_INDEX_PATH),
		listFiles(backend, NOTES_DIR),
		listFiles(backend, SKILLS_ROOT),
	]);

	const staleNotes: string[] = [];
	for (const file of [...noteFiles, ...skillFiles]) {
		if (msSince(file.modified_at, nowMs) > staleThreshold) {
			staleNotes.push(file.path);
		}
	}

	const indexedPaths = new Set<string>([
		...memoryIndex.entries.map((e) => e.path),
		...skillsIndex.entries.map((e) => e.path),
	]);
	const orphans: string[] = [];
	for (const file of [...noteFiles, ...skillFiles]) {
		if (file.path === SKILLS_INDEX_PATH) continue;
		if (!indexedPaths.has(file.path)) orphans.push(file.path);
	}

	const duplicates = [
		...findDuplicateSlugs(memoryIndex.entries),
		...findDuplicateSlugs(skillsIndex.entries),
	];

	const memoryChars =
		(await backendCharCount(backend, MEMORY_INDEX_PATH)) +
		(await backendCharCount(backend, SKILLS_INDEX_PATH));
	const overBudget =
		memoryChars > MEMORY_PROMPT_CHAR_CAP * LINT_OVER_BUDGET_RATIO
			? { memoryChars, skillsChars: 0 }
			: null;

	const userProfile = await readOrEmpty(backend, USER_PROFILE_PATH);
	const userProfileActuel = currentActuel(userProfile);
	const userProfileEmpty =
		userProfileActuel.length === 0 ||
		userProfileActuel === USER_PROFILE_PLACEHOLDER;

	return { staleNotes, orphans, duplicates, overBudget, userProfileEmpty };
}

async function backendCharCount(
	backend: BackendProtocol,
	path: string,
): Promise<number> {
	try {
		const data = await backend.readRaw(path);
		if (typeof data.content === "string") return data.content.length;
		if (data.content instanceof Uint8Array) return data.content.byteLength;
		return data.content.join("\n").length;
	} catch {
		return 0;
	}
}

export function formatMaintenanceBlock(findings: LintFindings): string {
	if (isEmpty(findings)) return "";
	const lines: string[] = ["## Memory maintenance"];
	if (findings.staleNotes.length > 0) {
		const shown = findings.staleNotes.slice(0, 5).join(", ");
		const more =
			findings.staleNotes.length > 5
				? ` (+${findings.staleNotes.length - 5} more)`
				: "";
		lines.push(
			`- ${findings.staleNotes.length} stale file(s) (>${LINT_STALE_DAYS}d): ${shown}${more}`,
		);
	}
	if (findings.orphans.length > 0) {
		const shown = findings.orphans.slice(0, 5).join(", ");
		const more =
			findings.orphans.length > 5
				? ` (+${findings.orphans.length - 5} more)`
				: "";
		lines.push(
			`- ${findings.orphans.length} orphan file(s) not in any index: ${shown}${more}`,
		);
	}
	if (findings.duplicates.length > 0) {
		lines.push(`- Duplicate slugs: ${findings.duplicates.join(", ")}`);
	}
	if (findings.overBudget) {
		lines.push(
			`- Indexes exceed budget (${findings.overBudget.memoryChars} chars vs ${MEMORY_PROMPT_CHAR_CAP} cap) — compact via rotate_actuel or consolidate notes.`,
		);
	}
	if (findings.userProfileEmpty) {
		lines.push(
			'- USER.md is empty. Before doing other work this turn, ask the user about their role, primary goal, and working-style preferences, then save what you learned with `memory_write` (target: "user"). One short set of questions — don\'t interrogate.',
		);
	}
	return lines.join("\n");
}
