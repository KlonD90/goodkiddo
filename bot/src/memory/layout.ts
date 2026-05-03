// Paths and sizing constants for the agent's per-caller memory wiki.
//
// Memory lives inside the workspace FS exposed by SqliteStateBackend, which is
// already namespaced per caller. Two peer subtrees:
//   /memory/   — facts the agent knows (notes, user profile, log)
//   /skills/   — procedural playbooks
//
// The index files (MEMORY.md, SKILLS.md) are the eager-loaded portion injected
// into the system prompt. Everything else is pulled on demand via the existing
// read_file / grep / glob tools.

export const MEMORY_ROOT = "/memory/";
export const MEMORY_INDEX_PATH = "/memory/MEMORY.md";
export const USER_PROFILE_PATH = "/memory/USER.md";
export const MEMORY_LOG_PATH = "/memory/log.md";
export const NOTES_DIR = "/memory/notes/";

export const SKILLS_ROOT = "/skills/";
export const SKILLS_INDEX_PATH = "/skills/SKILLS.md";

export const ACTUEL_HEADING = "## Actuel";
export const ARCHIVE_HEADING = "## Archive";
export const INDEX_HEADING = "## Index";

// Hard cap for the memory block injected into the system prompt. ~4 chars/token
// gives roughly 1500 tokens — fits comfortably alongside the identity prompt.
// NOTE: 4 chars/token is an approximation; non-English text (especially CJK/Russian
// characters) may encode at 2–3 chars/token, so actual token count varies.
export const MEMORY_PROMPT_CHAR_CAP = 6000;

// Lint thresholds (conservative defaults; tune once we have real sessions).
export const LINT_STALE_DAYS = 60;
export const LINT_OVER_BUDGET_RATIO = 1.1;

export function slugify(topic: string): string {
	return topic
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
}

export function notePath(topic: string): string {
	return `${NOTES_DIR}${slugify(topic)}.md`;
}

export function skillPath(name: string): string {
	return `${SKILLS_ROOT}${slugify(name)}.md`;
}
