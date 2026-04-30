import type { BackendProtocol } from "deepagents";
import { context, tool } from "langchain";
import { z } from "zod";
import { DRAFT_ARTIFACT_TYPES } from "./artifacts";
import { storeDraftArtifact } from "./generator";

const PREPARE_DRAFT_ARTIFACT_PROMPT = context`Prepare a private internal draft artifact before following up.

Use this for harmless safe-space preparation only: follow-up messages,
proposal outlines, checklists, decision memos, and content/social drafts.
The tool writes a markdown artifact inside GoodKiddo's virtual filesystem and
returns its path plus a preview. It never sends messages, publishes posts,
submits forms, shares files, or causes any outside-world final effect.`;

const DraftArtifactTypeSchema = z.enum(DRAFT_ARTIFACT_TYPES);

export function createPrepareDraftArtifactTool(backend: BackendProtocol) {
	return tool(
		async (input: {
			type: z.infer<typeof DraftArtifactTypeSchema>;
			title?: string;
			task: string;
			context?: string;
			evidence?: string[];
			source_paths?: string[];
			source_urls?: string[];
		}) => {
			try {
				const stored = await storeDraftArtifact(backend, input);
				return JSON.stringify(
					{
						id: stored.id,
						path: stored.path,
						type: stored.artifact.type,
						title: stored.artifact.title,
						visibility: "internal",
						notice:
							"Draft only - user sends/uses manually. No external send, publish, submit, or share was performed.",
						preview: stored.preview,
					},
					null,
					2,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
		{
			name: "prepare_draft_artifact",
			description: PREPARE_DRAFT_ARTIFACT_PROMPT,
			schema: z.object({
				type: DraftArtifactTypeSchema.describe("Prepared follow-up artifact type."),
				title: z
					.string()
					.optional()
					.describe("Optional artifact title. A safe default is generated when omitted."),
				task: z
					.string()
					.min(1)
					.describe("The task or follow-up this draft should prepare."),
				context: z
					.string()
					.optional()
					.describe("Relevant context summary to preserve in metadata and draft body."),
				evidence: z
					.array(z.string())
					.optional()
					.describe("Evidence, facts, or observations used to prepare the draft."),
				source_paths: z
					.array(z.string())
					.optional()
					.describe("Virtual filesystem paths that informed the draft."),
				source_urls: z
					.array(z.string())
					.optional()
					.describe("URLs that informed the draft."),
			}),
		},
	);
}
