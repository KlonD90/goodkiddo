export const DRAFT_ARTIFACT_TYPES = [
	"follow_up_message",
	"proposal_outline",
	"checklist",
	"decision_memo",
	"content_social_draft",
] as const;

export type DraftArtifactType = (typeof DRAFT_ARTIFACT_TYPES)[number];

export const DRAFT_ARTIFACTS_DIR = "/prepared-followups";
export const DRAFT_ARTIFACT_VISIBILITY = "internal";
export const DRAFT_ARTIFACT_NOTICE =
	"Draft only - user sends/uses manually. Internal GoodKiddo artifact; not sent, published, submitted, or shared externally.";

export type DraftArtifactSourceContext = {
	task?: string;
	summary?: string;
	evidence?: string[];
	source_paths?: string[];
	source_urls?: string[];
};

export type DraftArtifact = {
	title: string;
	type: DraftArtifactType;
	body: string;
	source_context: DraftArtifactSourceContext;
};

export type DraftArtifactMetadata = {
	title: string;
	type: DraftArtifactType;
	visibility: typeof DRAFT_ARTIFACT_VISIBILITY;
	source_context: DraftArtifactSourceContext;
};

function stripUnsafePathChars(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "draft-artifact";
}

export function buildDraftArtifactPath(id: string, title: string): string {
	const safeId = stripUnsafePathChars(id);
	const safeTitle = stripUnsafePathChars(title);
	return `${DRAFT_ARTIFACTS_DIR}/${safeId}-${safeTitle}.md`;
}

export function buildDraftArtifactMetadata(
	artifact: DraftArtifact,
): DraftArtifactMetadata {
	return {
		title: artifact.title,
		type: artifact.type,
		visibility: DRAFT_ARTIFACT_VISIBILITY,
		source_context: artifact.source_context,
	};
}

export function serializeDraftArtifactMarkdown(
	artifact: DraftArtifact,
): string {
	const metadata = buildDraftArtifactMetadata(artifact);
	return [
		`# ${artifact.title}`,
		"",
		DRAFT_ARTIFACT_NOTICE,
		"",
		"## Metadata",
		"",
		"```json",
		JSON.stringify(metadata, null, 2),
		"```",
		"",
		"## Draft",
		"",
		artifact.body,
		"",
	].join("\n");
}
