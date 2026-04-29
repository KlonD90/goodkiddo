import type { BackendProtocol } from "deepagents";
import { context, tool } from "langchain";
import { z } from "zod";
import {
	applyReplace,
	applyRotate,
	composeFresh,
} from "../memory/actuel_archive";
import { exists, overwrite, readOrEmpty } from "../memory/fs";
import { formatIndex, parseIndex, upsertEntry } from "../memory/index_manager";
import {
	MEMORY_INDEX_PATH,
	notePath,
	SKILLS_INDEX_PATH,
	skillPath,
	slugify,
	USER_PROFILE_PATH,
} from "../memory/layout";
import { appendLog, todayIso } from "../memory/log";
import { normalizeUserProfile } from "../memory/user_profile";
import { withLock } from "../utils/async_lock";

// Three guarded tools. No read tools — agent already has read_file/grep/glob
// pointed at the same backend. No lint tool — lint runs automatically and its
// findings surface in the system prompt.

const MODE_SCHEMA = z
	.enum(["replace", "rotate_actuel"])
	.default("replace")
	.describe(
		"replace = overwrite ## Actuel outright. rotate_actuel = move current ## Actuel into ## Archive under a dated heading, then set new ## Actuel. Use rotate_actuel when updating a persistent fact you want history for.",
	);

const MEMORY_WRITE_PROMPT = context`Save or update a durable fact.

Two targets:
  - target: "notes" (default) — writes /memory/notes/<slug>.md and updates
    the MEMORY.md index. Use for topic-scoped facts: project decisions,
    domain knowledge, lessons learned, named things worth looking up later.
  - target: "user" — writes /memory/USER.md (no index). Use for stable facts
    about the user: role, goals, working style, recurring preferences. The
    "topic" argument is ignored when target is "user". USER.md is normalized
    into fixed sections: Profile, Preferences, Environment, Constraints, and
    Open Questions.

Each file has a header, a ## Actuel section (current content), and a
## Archive section that grows when mode: "rotate_actuel" is used. USER.md is
the exception: it uses fixed profile sections instead of Actuel/Archive.

Returns the updated file excerpt so you can confirm the write.`;

const SKILL_WRITE_PROMPT = context`Save or update a procedural skill in /skills/.

Same file shape as memory_write — header, ## Actuel, ## Archive. SKILLS.md
index is auto-maintained.

Use when you've just executed a multi-step procedure end-to-end and the
pattern is reusable: when to reach for it (invocation conditions), inputs
needed, steps, known pitfalls. Skills are for things you can DO; notes are for
things you KNOW.`;

const MEMORY_APPEND_LOG_PROMPT = context`Append a one-line entry to /memory/log.md.

Format: ## [YYYY-MM-DD] op | detail. Use for noteworthy events:
preferences_learned, decision_made, task_completed, thread_closed, etc.
The log is append-only — pick a specific op name and a concise detail.`;

type WriteContext = {
	backend: BackendProtocol;
	targetPath: string;
	indexPath: string;
	slug: string;
	topic: string;
	content: string;
	mode: "replace" | "rotate_actuel";
	hook: string;
	now: Date;
};

export type MemoryMutationKind = "notes" | "user" | "skills";

export type MemoryMutationCallback = (
	kind: MemoryMutationKind,
) => void | Promise<void>;

function normalizeOneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function safeHeaderTitle(value: string): string {
	const normalized = normalizeOneLine(value);
	return normalized.length > 0 ? normalized : "Untitled";
}

function normalizeHook(hook: string | undefined, fallback: string): string {
	const normalized = normalizeOneLine(hook ?? "");
	return normalized.length > 0 ? normalized : normalizeOneLine(fallback);
}

function slugOrError(value: string, label: string): string {
	const slug = slugify(value);
	if (slug.length === 0) {
		throw new Error(
			`${label} must contain at least one ASCII letter or number so it can be indexed safely.`,
		);
	}
	return slug;
}

async function writeActuelFile(
	backend: BackendProtocol,
	targetPath: string,
	header: string,
	content: string,
	mode: "replace" | "rotate_actuel",
	now: Date,
): Promise<void> {
	const hadFile = await exists(backend, targetPath);
	const existing = hadFile ? await readOrEmpty(backend, targetPath) : "";
	let nextBody: string;
	if (!hadFile) {
		nextBody = composeFresh(header, content);
	} else if (mode === "rotate_actuel") {
		nextBody = applyRotate(existing, content, todayIso(now));
	} else {
		nextBody = applyReplace(existing, content);
	}
	await overwrite(backend, targetPath, nextBody);
}

async function performWrite(ctx: WriteContext): Promise<string> {
	// Serialize by indexPath: the note file + index update is a read-modify-write
	// pair. Without this, concurrent writes read the same stale index and the
	// last writer silently drops earlier entries.
	return withLock(ctx.indexPath, async () => {
		const header = `# ${safeHeaderTitle(ctx.topic)}`;
		await writeActuelFile(
			ctx.backend,
			ctx.targetPath,
			header,
			ctx.content,
			ctx.mode,
			ctx.now,
		);

		const indexRaw = await readOrEmpty(ctx.backend, ctx.indexPath);
		const { header: indexHeader, entries } = parseIndex(indexRaw);
		const nextEntries = upsertEntry(entries, {
			slug: ctx.slug,
			path: ctx.targetPath,
			hook: normalizeHook(ctx.hook, ctx.topic),
		});
		const indexFormatted = formatIndex(indexHeader, nextEntries);
		await overwrite(ctx.backend, ctx.indexPath, indexFormatted);

		return indexFormatted;
	});
}

async function performUserWrite(
	backend: BackendProtocol,
	content: string,
): Promise<string> {
	return withLock(USER_PROFILE_PATH, async () => {
		await overwrite(backend, USER_PROFILE_PATH, normalizeUserProfile(content));
		return readOrEmpty(backend, USER_PROFILE_PATH);
	});
}

export function createMemoryWriteTool(
	backend: BackendProtocol,
	onMutation?: MemoryMutationCallback,
) {
	return tool(
		async ({
			topic,
			content,
			hook,
			mode,
			target,
		}: {
			topic?: string;
			content: string;
			hook?: string;
			mode?: "replace" | "rotate_actuel";
			target?: "notes" | "user";
		}) => {
			try {
				const effectiveMode = mode ?? "replace";
				if (target === "user") {
					const updated = await performUserWrite(
						backend,
						content,
					);
					await onMutation?.("user");
					return `Saved to ${USER_PROFILE_PATH}.\n\n--- Updated USER.md ---\n${updated}`;
				}
				if (!topic || topic.trim().length === 0) {
					return "Error: topic is required when target is 'notes'.";
				}
				const slug = slugOrError(topic, "topic");
				const targetPath = notePath(topic);
				const updated = await performWrite({
					backend,
					targetPath,
					indexPath: MEMORY_INDEX_PATH,
					slug,
					topic,
					content,
					mode: effectiveMode,
					hook: hook ?? "",
					now: new Date(),
				});
				await onMutation?.("notes");
				return `Saved to ${targetPath}.\n\n--- Updated MEMORY.md ---\n${updated}`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
		{
			name: "memory_write",
			description: MEMORY_WRITE_PROMPT,
			schema: z.object({
				target: z
					.enum(["notes", "user"])
					.optional()
					.describe(
						"'notes' (default) writes an indexed topic under /memory/notes/. 'user' writes /memory/USER.md (topic/hook ignored).",
					),
				topic: z
					.string()
					.optional()
					.describe(
						"Topic title — becomes the file header and index slug. Required when target is 'notes'.",
					),
				content: z
					.string()
					.min(1)
					.describe("Body written under ## Actuel. Markdown allowed."),
				hook: z
					.string()
					.optional()
					.describe(
						"One-line hook for the MEMORY.md index. Defaults to the topic. Ignored when target is 'user'.",
					),
				mode: MODE_SCHEMA.optional(),
			}),
		},
	);
}

export function createSkillWriteTool(
	backend: BackendProtocol,
	onMutation?: MemoryMutationCallback,
) {
	return tool(
		async ({
			name,
			content,
			hook,
			mode,
		}: {
			name: string;
			content: string;
			hook?: string;
			mode?: "replace" | "rotate_actuel";
		}) => {
			try {
				const slug = slugOrError(name, "name");
				const targetPath = skillPath(name);
				const updated = await performWrite({
					backend,
					targetPath,
					indexPath: SKILLS_INDEX_PATH,
					slug,
					topic: name,
					content,
					mode: mode ?? "replace",
					hook: hook ?? "",
					now: new Date(),
				});
				await onMutation?.("skills");
				return `Saved skill to ${targetPath}.\n\n--- Updated SKILLS.md ---\n${updated}`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
		{
			name: "skill_write",
			description: SKILL_WRITE_PROMPT,
			schema: z.object({
				name: z
					.string()
					.min(1)
					.describe("Skill name — becomes the file header and index slug."),
				content: z
					.string()
					.min(1)
					.describe("Playbook body written under ## Actuel. Markdown allowed."),
				hook: z
					.string()
					.optional()
					.describe(
						"One-line hook for the SKILLS.md index. Defaults to the name.",
					),
				mode: MODE_SCHEMA.optional(),
			}),
		},
	);
}

export function createMemoryAppendLogTool(backend: BackendProtocol) {
	return tool(
		async ({ op, detail }: { op: string; detail: string }) => {
			try {
				const entry = await appendLog(backend, op, detail);
				return `Logged: ${entry.trim()}`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
		{
			name: "memory_append_log",
			description: MEMORY_APPEND_LOG_PROMPT,
			schema: z.object({
				op: z
					.string()
					.min(1)
					.describe(
						"Short operation name (e.g. 'preference_learned', 'decision', 'task_completed').",
					),
				detail: z
					.string()
					.min(1)
					.describe("One-line detail. Longer than a line gets flattened."),
			}),
		},
	);
}
