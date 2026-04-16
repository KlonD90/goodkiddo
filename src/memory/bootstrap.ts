import type { BackendProtocol } from "deepagents";
import { exists, overwrite } from "./fs";
import { formatIndex } from "./index_manager";
import {
	MEMORY_INDEX_PATH,
	MEMORY_LOG_PATH,
	SKILLS_INDEX_PATH,
	USER_PROFILE_PATH,
} from "./layout";

// Seed the four canonical memory files on first use. Idempotent: if a file
// already exists we leave it alone, so re-bootstrapping an established caller
// is a no-op and never clobbers curated content.

const MEMORY_HEADER = [
	"# MEMORY.md",
	"",
	"Your persistent memory index. Every entry under `## Index` points to a",
	"note under `/memory/notes/` with a one-line hook describing it.",
].join("\n");

const SKILLS_HEADER = [
	"# SKILLS.md",
	"",
	"Procedural playbooks. Every entry under `## Index` points to a skill under",
	"`/skills/` with a one-line hook describing when to reach for it.",
].join("\n");

const USER_PROFILE_TEMPLATE = [
	"# USER.md",
	"",
	"## Actuel",
	"_No profile yet. Populate as you learn about the user._",
].join("\n");

const LOG_TEMPLATE = "# Log\n";

export async function ensureMemoryBootstrapped(
	backend: BackendProtocol,
): Promise<void> {
	if (!(await exists(backend, MEMORY_INDEX_PATH))) {
		await overwrite(backend, MEMORY_INDEX_PATH, formatIndex(MEMORY_HEADER, []));
	}
	if (!(await exists(backend, SKILLS_INDEX_PATH))) {
		await overwrite(backend, SKILLS_INDEX_PATH, formatIndex(SKILLS_HEADER, []));
	}
	if (!(await exists(backend, USER_PROFILE_PATH))) {
		await overwrite(backend, USER_PROFILE_PATH, `${USER_PROFILE_TEMPLATE}\n`);
	}
	if (!(await exists(backend, MEMORY_LOG_PATH))) {
		await overwrite(backend, MEMORY_LOG_PATH, LOG_TEMPLATE);
	}
}
