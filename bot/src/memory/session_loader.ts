import type { BackendProtocol } from "deepagents";
import { readOrEmpty } from "./fs";
import {
	MEMORY_INDEX_PATH,
	MEMORY_PROMPT_CHAR_CAP,
	SKILLS_INDEX_PATH,
	USER_PROFILE_PATH,
} from "./layout";
import { formatMaintenanceBlock, runLint } from "./lint";
import MEMORY_PROMPT_MD from "./memory_prompt.md?raw";

// Composes the system prompt handed to createAgent():
//
//   <identity prompt>
//   ---
//   <memory rules>
//   ---
//   ## Current memory
//   <MEMORY.md>
//   <USER.md>
//   <SKILLS.md>
//   ---
//   <## Memory maintenance block, if lint flagged anything>
//
// Memory rules live in a dedicated markdown file so swapping the identity
// (DO_IT.md etc.) doesn't break memory discipline — and vice versa.
//
// The memory snapshot block is truncated to MEMORY_PROMPT_CHAR_CAP. When
// truncated, a marker nudges the agent toward compaction. Since the snapshot
// is read at agent-construction time, writes made during a session won't
// appear here until the next session — memory_write tools are responsible for
// returning the fresh index in their tool response so the in-session view
// stays coherent.

function truncateToCap(content: string, cap: number): string {
	if (content.length <= cap) return content;

	// Build suffix first so we can reserve its length from the cap.
	const estimateOverflow = (n: number) =>
		`\n\n... [${n} more entries truncated — use grep to retrieve specific topics, then run memory_lint or compact via rotate_actuel]`;
	const MAX_SUFFIX_ESTIMATE = 130; // safe upper bound for any overflow count
	const effectiveCap = cap - MAX_SUFFIX_ESTIMATE;

	// Split by newlines and accumulate line-by-line, never slicing mid-line.
	const lines = content.split("\n");
	const result: string[] = [];
	let total = 0;

	for (const line of lines) {
		const withSeparator = result.length > 0 ? line.length + 1 : line.length;
		if (total + withSeparator <= effectiveCap) {
			result.push(line);
			total += withSeparator;
		} else {
			break;
		}
	}

	const overflow = lines.length - result.length;
	const suffix = estimateOverflow(overflow);
	return result.join("\n") + suffix;
}

export async function composeMemorySnapshot(
	backend: BackendProtocol,
): Promise<string> {
	const [memory, user, skills] = await Promise.all([
		readOrEmpty(backend, MEMORY_INDEX_PATH),
		readOrEmpty(backend, USER_PROFILE_PATH),
		readOrEmpty(backend, SKILLS_INDEX_PATH),
	]);

	const sections: string[] = ["## Current memory"];
	if (memory.trim().length > 0) sections.push(memory.trim());
	if (user.trim().length > 0) sections.push(user.trim());
	if (skills.trim().length > 0) sections.push(skills.trim());

	const joined = sections.join("\n\n");
	return truncateToCap(joined, MEMORY_PROMPT_CHAR_CAP);
}

export async function buildSystemPrompt(options: {
	identityPrompt: string;
	backend: BackendProtocol;
	activeTaskSnapshot?: string;
	runtimeContextBlock?: string;
	now?: Date;
}): Promise<string> {
	const {
		identityPrompt,
		backend,
		activeTaskSnapshot,
		runtimeContextBlock,
		now,
	} = options;
	const [snapshot, findings] = await Promise.all([
		composeMemorySnapshot(backend),
		runLint(backend, now),
	]);
	const maintenance = formatMaintenanceBlock(findings);

	const parts: string[] = [
		identityPrompt.trim(),
		"---",
		MEMORY_PROMPT_MD.trim(),
		"---",
		snapshot,
	];
	if (activeTaskSnapshot && activeTaskSnapshot.trim().length > 0) {
		parts.push("---", activeTaskSnapshot.trim());
	}
	if (maintenance.length > 0) {
		parts.push("---", maintenance);
	}
	if (runtimeContextBlock && runtimeContextBlock.trim().length > 0) {
		parts.push("---", runtimeContextBlock.trim());
	}
	return parts.join("\n\n");
}
