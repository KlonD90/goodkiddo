import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../../backends";
import { createDb, detectDialect } from "../../db";
import { fileDataToString } from "../../utils/filesystem";
import { DRAFT_ARTIFACT_NOTICE, DRAFT_ARTIFACT_TYPES } from "./artifacts";
import { generateDraftArtifact, storeDraftArtifact } from "./generator";
import { createPrepareDraftArtifactTool } from "./tool";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return {
		backend: new SqliteStateBackend({ db, dialect, namespace }),
		db,
	};
}

describe("generateDraftArtifact", () => {
	test("generates a draft artifact from task, context, and evidence input", () => {
		const generated = generateDraftArtifact(
			{
				type: "follow_up_message",
				title: "ACME follow-up",
				task: "confirm Friday delivery",
				context: "ACME asked whether the timeline still holds.",
				evidence: ["Proposal says delivery is Friday."],
				source_paths: ["/memory/notes/acme.md"],
				source_urls: ["https://example.com/acme"],
			},
			"d-fixed123",
		);

		expect(generated.id).toBe("d-fixed123");
		expect(generated.path).toBe("/prepared-followups/d-fixed123-acme-follow-up.md");
		expect(generated.artifact.source_context).toEqual({
			task: "confirm Friday delivery",
			summary: "ACME asked whether the timeline still holds.",
			evidence: ["Proposal says delivery is Friday."],
			source_paths: ["/memory/notes/acme.md"],
			source_urls: ["https://example.com/acme"],
		});
		expect(generated.markdown).toContain('"visibility": "internal"');
		expect(generated.markdown).toContain(DRAFT_ARTIFACT_NOTICE);
		expect(generated.markdown).toContain("## Follow-up Message Draft");
		expect(generated.preview).toContain("ACME follow-up");
	});

	test("supports every v1 artifact type with a clear template", () => {
		const expectations = {
			follow_up_message: [
				"## Follow-up Message Draft",
				"[Recipient name],",
				"Suggested next step: [clear next step for the recipient].",
				"[Your name]",
			],
			proposal_outline: [
				"## Proposal Outline Draft",
				"Objective: prepare next step",
				"Proposed sections:",
				"- Deliverables",
				"- Manual next step for the user",
			],
			checklist: [
				"## Checklist Draft",
				"Purpose: prepare next step",
				"Checklist:",
				"- [ ] Verify facts, names, dates, and amounts",
				"- [ ] Send, publish, submit, or use manually outside GoodKiddo if desired",
			],
			decision_memo: [
				"## Decision Memo Draft",
				"Decision to make: prepare next step",
				"Options:",
				"Recommendation draft:",
				"[State the recommended option and why. User decides manually.]",
			],
			content_social_draft: [
				"## Content/Social Draft",
				"Topic: prepare next step",
				"Supporting points:",
				"Draft:",
				"- [ ] Adapt to the target platform",
			],
		} satisfies Record<(typeof DRAFT_ARTIFACT_TYPES)[number], string[]>;

		for (const type of DRAFT_ARTIFACT_TYPES) {
			const generated = generateDraftArtifact(
				{
					type,
					task: "prepare next step",
					context: "Existing customer context.",
					evidence: ["Known fact."],
				},
				`d-${type}`,
			);

			expect(generated.artifact.type).toBe(type);
			expect(generated.artifact.body).toContain("Known fact.");
			expect(generated.artifact.body).toContain(DRAFT_ARTIFACT_NOTICE);
			for (const expected of expectations[type]) {
				expect(generated.artifact.body).toContain(expected);
			}
		}
	});

	test("preserves normalized source context in metadata and markdown", () => {
		const generated = generateDraftArtifact(
			{
				type: "decision_memo",
				title: " Package decision ",
				task: " choose the retainer package ",
				context: "  Client is comparing monthly options.  ",
				evidence: [" Starter costs less. ", "", "Pro includes reporting."],
				source_paths: [" /memory/clients/acme.md ", ""],
				source_urls: [" https://example.com/proposal ", ""],
			},
			"d-context1",
		);

		expect(generated.artifact.source_context).toEqual({
			task: "choose the retainer package",
			summary: "Client is comparing monthly options.",
			evidence: ["Starter costs less.", "Pro includes reporting."],
			source_paths: ["/memory/clients/acme.md"],
			source_urls: ["https://example.com/proposal"],
		});
		expect(generated.markdown).toContain('"source_context"');
		expect(generated.markdown).toContain('"task": "choose the retainer package"');
		expect(generated.markdown).toContain('"summary": "Client is comparing monthly options."');
		expect(generated.markdown).toContain('"source_paths"');
		expect(generated.markdown).toContain('/memory/clients/acme.md');
		expect(generated.markdown).toContain('"source_urls"');
		expect(generated.markdown).toContain("https://example.com/proposal");
	});
});

describe("prepare_draft_artifact tool", () => {
	test("stores the artifact internally and returns path plus preview", async () => {
		const { backend, db } = createBackend("prepared-followups-tool");
		const tool = createPrepareDraftArtifactTool(backend);

		const result = await tool.invoke({
			type: "checklist",
			title: "Launch checklist",
			task: "prepare launch follow-up",
			context: "Launch is planned for Monday.",
			evidence: ["Pricing page is ready."],
			source_paths: ["/memory/notes/launch.md"],
		});

		const parsed = JSON.parse(String(result));
		expect(parsed.path).toMatch(
			/^\/prepared-followups\/d-[a-z0-9]{8}-launch-checklist\.md$/,
		);
		expect(parsed.visibility).toBe("internal");
		expect(parsed.notice).toContain("No external send, publish, submit, or share");
		expect(parsed.preview).toContain("Launch checklist");

		const stored = fileDataToString(await backend.readRaw(parsed.path));
		expect(stored).toContain("## Checklist Draft");
		expect(stored).toContain('"source_paths"');
		expect(stored).toContain("/memory/notes/launch.md");
		expect(stored).not.toContain("send_file");

		await db.close();
	});

	test("creates only an internal virtual filesystem artifact and performs no external send", async () => {
		const { backend, db } = createBackend("prepared-followups-internal-only");
		const tool = createPrepareDraftArtifactTool(backend);

		const result = await tool.invoke({
			type: "follow_up_message",
			title: "Do not send this",
			task: "draft a client nudge",
			context: "The client has not replied.",
			evidence: ["Last contact was three days ago."],
		});

		const parsed = JSON.parse(String(result));
		expect(parsed.visibility).toBe("internal");
		expect(parsed.path).toStartWith("/prepared-followups/");
		expect(parsed.notice).toBe(
			"Draft only - user sends/uses manually. No external send, publish, submit, or share was performed.",
		);
		expect(String(result)).not.toContain("sent_at");
		expect(String(result)).not.toContain("message_id");
		expect(String(result)).not.toContain("published_url");
		expect(String(result)).not.toContain("submission_id");

		const stored = fileDataToString(await backend.readRaw(parsed.path));
		expect(stored).toContain('"visibility": "internal"');
		expect(stored).toContain(DRAFT_ARTIFACT_NOTICE);
		expect(stored).not.toContain("send_file");
		expect(stored).not.toContain("share_file");
		expect(stored).not.toContain("external_delivery");

		await db.close();
	});

	test("storeDraftArtifact returns the stored artifact without markdown payload", async () => {
		const { backend, db } = createBackend("prepared-followups-store");

		const stored = await storeDraftArtifact(backend, {
			type: "decision_memo",
			task: "choose package",
			context: "Two packages are viable.",
			evidence: ["Starter is cheaper.", "Pro saves time."],
		});

		expect(stored.path).toMatch(/^\/prepared-followups\/d-[a-z0-9]{8}-/);
		expect("markdown" in stored).toBe(false);
		expect(stored.preview).toContain("Decision memo");

		await db.close();
	});
});
