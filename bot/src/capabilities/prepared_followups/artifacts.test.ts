import { describe, expect, test } from "bun:test";
import {
	buildDraftArtifactMetadata,
	buildDraftArtifactPath,
	DRAFT_ARTIFACT_NOTICE,
	DRAFT_ARTIFACT_TYPES,
	type DraftArtifact,
	serializeDraftArtifactMarkdown,
} from "./artifacts";

const baseArtifact: DraftArtifact = {
	title: "Follow up with ACME",
	type: "follow_up_message",
	body: "Hi Sam,\n\nJust checking whether the proposal still works for Friday.",
	source_context: {
		task: "Prepare a follow-up",
		summary: "Client asked for timing confirmation.",
		evidence: ["Last proposal said Friday delivery."],
		source_paths: ["/research/r-12345678.md"],
		source_urls: ["https://example.com/context"],
	},
};

describe("draft artifact model", () => {
	test("defines the v1 artifact types", () => {
		expect(DRAFT_ARTIFACT_TYPES).toEqual([
			"follow_up_message",
			"proposal_outline",
			"checklist",
			"decision_memo",
			"content_social_draft",
		]);
	});

	test("builds internal metadata with title, type, body-adjacent source context", () => {
		const metadata = buildDraftArtifactMetadata(baseArtifact);

		expect(metadata).toEqual({
			title: "Follow up with ACME",
			type: "follow_up_message",
			visibility: "internal",
			source_context: baseArtifact.source_context,
		});
	});

	test("serializes as a private draft markdown artifact", () => {
		const markdown = serializeDraftArtifactMarkdown(baseArtifact);

		expect(markdown.startsWith("# Follow up with ACME\n\n")).toBe(true);
		expect(markdown).toContain(DRAFT_ARTIFACT_NOTICE);
		expect(markdown).toContain('"visibility": "internal"');
		expect(markdown).toContain('"source_context"');
		expect(markdown).toContain("## Draft\n\nHi Sam");
		expect(markdown).not.toContain("send_file");
		expect(markdown).not.toContain("outbound");
	});

	test("uses a virtual filesystem path under the prepared follow-ups directory", () => {
		expect(buildDraftArtifactPath("r-123_ABC", "Client Follow-up!")).toBe(
			"/prepared-followups/r-123-abc-client-follow-up.md",
		);
	});
});
