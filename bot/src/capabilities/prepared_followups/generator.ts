import { randomUUID } from "node:crypto";
import type { BackendProtocol } from "deepagents";
import {
	buildDraftArtifactPath,
	DRAFT_ARTIFACT_NOTICE,
	type DraftArtifact,
	type DraftArtifactSourceContext,
	type DraftArtifactType,
	serializeDraftArtifactMarkdown,
} from "./artifacts";

const PREVIEW_CHAR_LIMIT = 600;
const WRITE_ATTEMPTS = 3;

export type DraftArtifactGenerationInput = {
	type: DraftArtifactType;
	title?: string;
	task: string;
	context?: string;
	evidence?: string[];
	source_paths?: string[];
	source_urls?: string[];
};

export type GeneratedDraftArtifact = {
	id: string;
	path: string;
	artifact: DraftArtifact;
	markdown: string;
	preview: string;
};

export type StoredDraftArtifact = Omit<GeneratedDraftArtifact, "markdown">;

function normalizeText(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function cleanList(values: string[] | undefined): string[] | undefined {
	const cleaned = (values ?? []).map(normalizeText).filter(Boolean);
	return cleaned.length > 0 ? cleaned : undefined;
}

function bulletList(values: string[] | undefined, fallback: string): string {
	const cleaned = cleanList(values);
	if (!cleaned) return `- ${fallback}`;
	return cleaned.map((value) => `- ${value}`).join("\n");
}

function defaultTitle(type: DraftArtifactType, task: string): string {
	const normalizedTask = normalizeText(task);
	const suffix = normalizedTask ? `: ${normalizedTask}` : "";
	switch (type) {
		case "follow_up_message":
			return `Follow-up message${suffix}`;
		case "proposal_outline":
			return `Proposal outline${suffix}`;
		case "checklist":
			return `Checklist${suffix}`;
		case "decision_memo":
			return `Decision memo${suffix}`;
		case "content_social_draft":
			return `Content/social draft${suffix}`;
	}
}

function evidenceSection(evidence: string[] | undefined): string {
	return bulletList(
		evidence,
		"No explicit evidence supplied; verify before using.",
	);
}

function contextLine(context: string | undefined): string {
	return normalizeText(context) || "No additional context supplied.";
}

function buildTemplate(input: DraftArtifactGenerationInput): string {
	const task = normalizeText(input.task);
	const context = contextLine(input.context);
	const evidence = evidenceSection(input.evidence);

	switch (input.type) {
		case "follow_up_message":
			return [
				"## Follow-up Message Draft",
				"",
				"[Recipient name],",
				"",
				`I'm following up on ${task || "our previous conversation"}. ${context}`,
				"",
				"Based on what I have:",
				evidence,
				"",
				"Suggested next step: [clear next step for the recipient].",
				"",
				"Thanks,",
				"[Your name]",
				"",
				DRAFT_ARTIFACT_NOTICE,
			].join("\n");
		case "proposal_outline":
			return [
				"## Proposal Outline Draft",
				"",
				`Objective: ${task || "Clarify the proposed work and next decision."}`,
				"",
				`Context: ${context}`,
				"",
				"Evidence and inputs:",
				evidence,
				"",
				"Proposed sections:",
				"- Client goal",
				"- Current situation",
				"- Recommended approach",
				"- Deliverables",
				"- Timeline",
				"- Pricing or effort estimate",
				"- Assumptions and open questions",
				"- Manual next step for the user",
				"",
				DRAFT_ARTIFACT_NOTICE,
			].join("\n");
		case "checklist":
			return [
				"## Checklist Draft",
				"",
				`Purpose: ${task || "Prepare the next manual action."}`,
				"",
				`Context: ${context}`,
				"",
				"Inputs checked:",
				evidence,
				"",
				"Checklist:",
				"- [ ] Confirm the goal and intended recipient/audience",
				"- [ ] Verify facts, names, dates, and amounts",
				"- [ ] Fill any placeholders",
				"- [ ] Decide whether to use, edit, or discard this draft",
				"- [ ] Send, publish, submit, or use manually outside GoodKiddo if desired",
				"",
				DRAFT_ARTIFACT_NOTICE,
			].join("\n");
		case "decision_memo":
			return [
				"## Decision Memo Draft",
				"",
				`Decision to make: ${task || "Choose the next step."}`,
				"",
				`Context: ${context}`,
				"",
				"Evidence:",
				evidence,
				"",
				"Options:",
				"- Option A: [describe]",
				"- Option B: [describe]",
				"- Do nothing now: [tradeoff]",
				"",
				"Recommendation draft:",
				"[State the recommended option and why. User decides manually.]",
				"",
				"Open questions:",
				"- [ ] [specific missing detail]",
				"",
				DRAFT_ARTIFACT_NOTICE,
			].join("\n");
		case "content_social_draft":
			return [
				"## Content/Social Draft",
				"",
				`Topic: ${task || "Prepared post or content idea."}`,
				"",
				`Context: ${context}`,
				"",
				"Supporting points:",
				evidence,
				"",
				"Draft:",
				"[Hook]",
				"",
				"[Main point with useful detail]",
				"",
				"[Soft call to action or closing thought]",
				"",
				"Before using manually:",
				"- [ ] Check accuracy and tone",
				"- [ ] Adapt to the target platform",
				"- [ ] Add any required links, images, or disclosures",
				"",
				DRAFT_ARTIFACT_NOTICE,
			].join("\n");
	}
}

function buildSourceContext(
	input: DraftArtifactGenerationInput,
): DraftArtifactSourceContext {
	return {
		task: normalizeText(input.task),
		summary: normalizeText(input.context) || undefined,
		evidence: cleanList(input.evidence),
		source_paths: cleanList(input.source_paths),
		source_urls: cleanList(input.source_urls),
	};
}

function buildPreview(markdown: string): string {
	if (markdown.length <= PREVIEW_CHAR_LIMIT) return markdown;
	return `${markdown.slice(0, PREVIEW_CHAR_LIMIT - 3)}...`;
}

export function mintDraftArtifactId(): string {
	return `d-${randomUUID()}`;
}

export function generateDraftArtifact(
	input: DraftArtifactGenerationInput,
	id = mintDraftArtifactId(),
): GeneratedDraftArtifact {
	const title =
		normalizeText(input.title) || defaultTitle(input.type, input.task);
	const artifact: DraftArtifact = {
		title,
		type: input.type,
		body: buildTemplate(input),
		source_context: buildSourceContext(input),
	};
	const path = buildDraftArtifactPath(id, title);
	const markdown = serializeDraftArtifactMarkdown(artifact);

	return {
		id,
		path,
		artifact,
		markdown,
		preview: buildPreview(markdown),
	};
}

export async function storeDraftArtifact(
	backend: BackendProtocol,
	input: DraftArtifactGenerationInput,
): Promise<StoredDraftArtifact> {
	let lastError: string | undefined;

	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
		const generated = generateDraftArtifact(input);
		const result = await backend.write(generated.path, generated.markdown);
		if (!("error" in result) || !result.error) {
			const { markdown: _markdown, ...stored } = generated;
			return stored;
		}

		lastError = result.error;
		if (!result.error.toLowerCase().includes("already exists")) {
			break;
		}
	}

	throw new Error(lastError ?? "Failed to store draft artifact");
}
