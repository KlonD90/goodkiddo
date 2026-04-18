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
} from "../memory/layout";
import { appendLog, todayIso } from "../memory/log";

// Three guarded tools. No read tools — agent already has read_file/grep/glob
// pointed at the same backend. No lint tool — lint runs automatically and its
// findings surface in the system prompt.

const MODE_SCHEMA = z
	.enum(["replace", "rotate_actuel"])
	.default("replace")
	.describe(
		"replace = overwrite ## Actuel outright. rotate_actuel = move current ## Actuel into ## Archive under a dated heading, then set new ## Actuel. Use rotate_actuel when updating a persistent fact you want history for.",
	);

const MEMORY_WRITE_PROMPT = context`Save or update a note in /memory/notes/.

Each note has a header (first line, typically a # title), a ## Actuel section
(the current content), and a ## Archive section that grows over time as
rotate_actuel is used. The index in MEMORY.md is auto-maintained.

Use for durable facts worth remembering beyond the current turn: user
preferences, decisions and their reasoning, lessons learned, domain knowledge
the user has shared. Don't use for ephemeral in-conversation scratch.

Returns the updated MEMORY.md excerpt so you can confirm the index.`;

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
	topic: string;
	content: string;
	mode: "replace" | "rotate_actuel";
	hook: string;
	now: Date;
};

async function performWrite(ctx: WriteContext): Promise<string> {
	const slug = slugify(ctx.topic);
	const header = `# ${ctx.topic.trim()}`;
	const hadFile = await exists(ctx.backend, ctx.targetPath);
	const existing = hadFile
		? await readOrEmpty(ctx.backend, ctx.targetPath)
		: "";

	let nextBody: string;
	if (!hadFile) {
		nextBody = composeFresh(header, ctx.content);
	} else if (ctx.mode === "rotate_actuel") {
		nextBody = applyRotate(existing, ctx.content, todayIso(ctx.now));
	} else {
		nextBody = applyReplace(existing, ctx.content);
	}

	await overwrite(ctx.backend, ctx.targetPath, nextBody);

	const indexRaw = await readOrEmpty(ctx.backend, ctx.indexPath);
	const { header: indexHeader, entries } = parseIndex(indexRaw);
	const nextEntries = upsertEntry(entries, {
		slug,
		path: ctx.targetPath,
		hook: ctx.hook.trim() || ctx.topic.trim(),
	});
	const indexFormatted = formatIndex(indexHeader, nextEntries);
	await overwrite(ctx.backend, ctx.indexPath, indexFormatted);

	return indexFormatted;
}

export function createMemoryWriteTool(backend: BackendProtocol) {
	return tool(
		async ({
			topic,
			content,
			hook,
			mode,
		}: {
			topic: string;
			content: string;
			hook?: string;
			mode?: "replace" | "rotate_actuel";
		}) => {
			try {
				const targetPath = notePath(topic);
				const updated = await performWrite({
					backend,
					targetPath,
					indexPath: MEMORY_INDEX_PATH,
					topic,
					content,
					mode: mode ?? "replace",
					hook: hook ?? "",
					now: new Date(),
				});
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
				topic: z
					.string()
					.min(1)
					.describe("Topic title — becomes the file header and index slug."),
				content: z
					.string()
					.min(1)
					.describe("Body written under ## Actuel. Markdown allowed."),
				hook: z
					.string()
					.optional()
					.describe(
						"One-line hook for the MEMORY.md index. Defaults to the topic.",
					),
				mode: MODE_SCHEMA.optional(),
			}),
		},
	);
}

export function createSkillWriteTool(backend: BackendProtocol) {
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
				const targetPath = skillPath(name);
				const updated = await performWrite({
					backend,
					targetPath,
					indexPath: SKILLS_INDEX_PATH,
					topic: name,
					content,
					mode: mode ?? "replace",
					hook: hook ?? "",
					now: new Date(),
				});
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
