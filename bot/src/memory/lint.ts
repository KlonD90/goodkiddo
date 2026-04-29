import type { BackendProtocol, FileInfo } from "deepagents";
import { readOrEmpty } from "./fs";
import { parseIndexDetailed, readIndexFile } from "./index_manager";
import {
	ACTUEL_HEADING,
	LINT_OVER_BUDGET_RATIO,
	LINT_STALE_DAYS,
	MEMORY_INDEX_PATH,
	MEMORY_PROMPT_CHAR_CAP,
	MEMORY_ROOT,
	NOTES_DIR,
	SKILLS_INDEX_PATH,
	SKILLS_ROOT,
	USER_PROFILE_PATH,
} from "./layout";
import {
	isStructuredUserProfile,
	userProfileIsEmpty,
} from "./user_profile";

// File listing paths that are intentionally kept without modification
// and should not trigger stale warnings. Format: JSON array of string paths.
// Users can edit this file directly to acknowledge long-lived but valid files.
export const LINT_RESOLVED_PATH = `${MEMORY_ROOT}.lint_resolved.json`;

// Pure-function health check over the memory subtrees. Findings surface to the
// agent via the `## Memory maintenance` block appended to the system prompt by
// session_loader — never as a tool the LLM can call. Keeping it implicit means
// the agent can't avoid or game it, and it costs zero tokens when the store is
// clean.

export type LintFindings = {
	staleNotes: string[]; // paths of files with mtime older than LINT_STALE_DAYS
	orphans: string[]; // files present on disk but not in the index
	duplicates: string[]; // slugs appearing more than once in an index
	malformedIndexLines: string[]; // index lines that do not match the strict contract
	emptySlugPaths: string[]; // paths like /memory/notes/.md or /skills/.md
	missingActuelPaths: string[]; // note/skill files missing ## Actuel
	overBudget: { memoryChars: number; skillsChars: number } | null;
	userProfileEmpty: boolean; // USER.md has no durable facts in its current shape
	userProfileUnstructured: boolean; // USER.md has not been updated to fixed sections
};

export function isEmpty(findings: LintFindings): boolean {
	return (
		findings.staleNotes.length === 0 &&
		findings.orphans.length === 0 &&
		findings.duplicates.length === 0 &&
		findings.malformedIndexLines.length === 0 &&
		findings.emptySlugPaths.length === 0 &&
		findings.missingActuelPaths.length === 0 &&
		findings.overBudget === null &&
		!findings.userProfileEmpty &&
		!findings.userProfileUnstructured
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

function isMemoryContentFile(path: string): boolean {
	return (
		path.startsWith(NOTES_DIR) ||
		(path.startsWith(SKILLS_ROOT) && path !== SKILLS_INDEX_PATH)
	);
}

function isExemptMarker(path: string): boolean {
	return path.endsWith(".archived") || path.endsWith(".permanent");
}

function hasEmptySlugPath(path: string): boolean {
	return path.endsWith("/.md");
}

function hasActuelSection(content: string): boolean {
	return new RegExp(`(^|\\n)${ACTUEL_HEADING}(\\n|$)`).test(content);
}

async function findMissingActuelPaths(
	backend: BackendProtocol,
	files: FileInfo[],
): Promise<string[]> {
	const results = await Promise.all(
		files
			.filter((file) => isMemoryContentFile(file.path))
			.map(async (file) => {
				const content = await readOrEmpty(backend, file.path);
				return hasActuelSection(content) ? null : file.path;
			}),
	);
	return results.filter((path): path is string => path !== null);
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
	const [memoryIndexRaw, skillsIndexRaw] = await Promise.all([
		readOrEmpty(backend, MEMORY_INDEX_PATH),
		readOrEmpty(backend, SKILLS_INDEX_PATH),
	]);
	const malformedIndexLines = [
		...parseIndexDetailed(memoryIndexRaw).malformedLines.map(
			(line) => `${MEMORY_INDEX_PATH}: ${line}`,
		),
		...parseIndexDetailed(skillsIndexRaw).malformedLines.map(
			(line) => `${SKILLS_INDEX_PATH}: ${line}`,
		),
	];

	// Files with a .permanent or .archived marker are exempt from stale warnings.
	const exemptPaths = new Set<string>();
	for (const file of [...noteFiles, ...skillFiles]) {
		if (file.path.endsWith(".permanent") || file.path.endsWith(".archived")) {
			const base = file.path.endsWith(".permanent")
				? file.path.slice(0, -".permanent".length)
				: file.path.slice(0, -".archived".length);
			exemptPaths.add(base);
		}
	}

	const staleNotes: string[] = [];
	for (const file of [...noteFiles, ...skillFiles]) {
		if (
			msSince(file.modified_at, nowMs) > staleThreshold &&
			!exemptPaths.has(file.path)
		) {
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
		if (isExemptMarker(file.path)) continue;
		if (!indexedPaths.has(file.path)) orphans.push(file.path);
	}

	const duplicates = [
		...findDuplicateSlugs(memoryIndex.entries),
		...findDuplicateSlugs(skillsIndex.entries),
	];
	const allContentFiles = [...noteFiles, ...skillFiles].filter((file) =>
		isMemoryContentFile(file.path),
	);
	const emptySlugPaths = allContentFiles
		.map((file) => file.path)
		.filter(hasEmptySlugPath)
		.filter((path) => !isExemptMarker(path));
	const missingActuelPaths = await findMissingActuelPaths(
		backend,
		allContentFiles,
	);

	const memoryChars =
		(await backendCharCount(backend, MEMORY_INDEX_PATH)) +
		(await backendCharCount(backend, USER_PROFILE_PATH)) +
		(await backendCharCount(backend, SKILLS_INDEX_PATH));
	const overBudget =
		memoryChars > MEMORY_PROMPT_CHAR_CAP * LINT_OVER_BUDGET_RATIO
			? { memoryChars, skillsChars: 0 }
			: null;

	const userProfile = await readOrEmpty(backend, USER_PROFILE_PATH);
	const userProfileEmpty = userProfileIsEmpty(userProfile);
	const userProfileUnstructured =
		userProfile.trim().length > 0 && !isStructuredUserProfile(userProfile);

	return {
		staleNotes,
		orphans,
		duplicates,
		malformedIndexLines,
		emptySlugPaths,
		missingActuelPaths,
		overBudget,
		userProfileEmpty,
		userProfileUnstructured,
	};
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
	if (findings.malformedIndexLines.length > 0) {
		const shown = findings.malformedIndexLines.slice(0, 5).join("; ");
		const more =
			findings.malformedIndexLines.length > 5
				? ` (+${findings.malformedIndexLines.length - 5} more)`
				: "";
		lines.push(`- Malformed index line(s): ${shown}${more}`);
	}
	if (findings.emptySlugPaths.length > 0) {
		lines.push(
			`- Empty-slug memory path(s): ${findings.emptySlugPaths.join(", ")}`,
		);
	}
	if (findings.missingActuelPaths.length > 0) {
		const shown = findings.missingActuelPaths.slice(0, 5).join(", ");
		const more =
			findings.missingActuelPaths.length > 5
				? ` (+${findings.missingActuelPaths.length - 5} more)`
				: "";
		lines.push(`- Note/skill file(s) missing ## Actuel: ${shown}${more}`);
	}
	if (findings.overBudget) {
		lines.push(
			`- Indexes exceed budget (${findings.overBudget.memoryChars} chars vs ${MEMORY_PROMPT_CHAR_CAP} cap) — compact via rotate_actuel or consolidate notes.`,
		);
	}
	if (findings.userProfileEmpty) {
		lines.push(
			'- USER.md has no durable user facts yet. Continue with the user request; only ask a small profile question when it directly helps the task, then save the answer with `memory_write` (target: "user").',
		);
	}
	if (findings.userProfileUnstructured) {
		lines.push(
			'- USER.md uses the legacy unstructured shape. On the next explicit user-profile update, rewrite it with the fixed sections: Profile, Preferences, Environment, Constraints, Open Questions.',
		);
	}
	return lines.join("\n");
}
