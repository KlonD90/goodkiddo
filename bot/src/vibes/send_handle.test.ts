import { describe, expect, test } from "bun:test";
import {
	decideSendHandle,
	getSendHandleContext,
	isForbiddenSelfPraise,
} from "./send_handle";
import {
	forbiddenSelfPraisePhrases,
	sendHandleFixtures,
} from "./send_handle_fixtures";

describe("Send Handle deterministic gating", () => {
	for (const fixture of sendHandleFixtures) {
		test(`${fixture.id}: ${fixture.description}`, () => {
			const decision = decideSendHandle({
				currentUserText: fixture.currentUserText,
				recentMessages: fixture.recentMessages,
				channel: fixture.channel,
			});

			expect(decision.eligible).toBe(fixture.expectCandidate);
			if (fixture.expectCandidate) {
				expect(decision).toMatchObject({
					eligible: true,
					trigger: fixture.expectedTrigger,
					channel: fixture.channel,
				});
				if (decision.eligible) {
					expect(decision.context).toContain("[Good Vibes: Send Handle]");
					expect(decision.context).toContain("small practical handhold");
					expect(decision.context).toContain(
						"user can send, check, trim, or reuse",
					);
					expect(decision.context).toContain("Do not add self-praise");
					expect(decision.context).not.toContain("Thread Ribbon");
					for (const example of fixture.expectedHandleExamples ?? []) {
						expect(decision.context).toContain(example);
					}
				}
			} else {
				expect(decision).toMatchObject({
					eligible: false,
					offReason: fixture.expectedOffReason,
				});
			}
		});
	}

	test("does not emit context for empty or multimodal-only text", () => {
		expect(
			getSendHandleContext({
				currentUserText: "   ",
				recentMessages: [],
				channel: "telegram",
			}),
		).toBeUndefined();
	});

	test("runtime prompt bans rejected self-praise patterns", () => {
		const context = getSendHandleContext({
			currentUserText:
				"This customer chat is messy. Draft a kind reply and a question I should ask.",
			recentMessages: [],
			channel: "telegram",
		});
		expect(context).toBeDefined();
		expect(context).toContain("Never write: Tiny win");
		expect(context).toContain("we cleaned");
		expect(context).toContain("GoodKiddo solved");
		for (const phrase of forbiddenSelfPraisePhrases) {
			expect(isForbiddenSelfPraise(phrase)).toBe(true);
		}
		expect(isForbiddenSelfPraise("Before sending: confirm the ETA.")).toBe(
			false,
		);
	});

	test("runtime prompt keeps surveillance and cringe markers out", () => {
		const context = getSendHandleContext({
			currentUserText:
				"This customer chat is messy. Draft a kind reply and a question I should ask.",
			recentMessages: [],
			channel: "telegram",
		});
		expect(context).toBeDefined();
		expect(context).toContain('Avoid: "I noticed", "as an AI"');
		expect(context).toContain("Zero or one emoji max");
		expect(context).toContain("human decides what to send");
	});
});
