import { describe, expect, test } from "bun:test";
import { decideThreadRibbon, getThreadRibbonContext } from "./thread_ribbon";
import { threadRibbonFixtures } from "./thread_ribbon_fixtures";

describe("Thread Ribbon deterministic gating", () => {
	for (const fixture of threadRibbonFixtures) {
		test(`${fixture.id}: ${fixture.description}`, () => {
			const decision = decideThreadRibbon({
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
					expect(decision.context).toContain("[Good Vibes: Thread Ribbon]");
					expect(decision.context).toContain("under 18 words");
					expect(decision.context).toContain("Skip the ribbon");
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
			getThreadRibbonContext({
				currentUserText: "   ",
				recentMessages: [],
				channel: "telegram",
			}),
		).toBeUndefined();
	});

	test("runtime prompt forbids surveillance and cringe markers", () => {
		const context = getThreadRibbonContext({
			currentUserText:
				"This customer chat is messy. Draft a kind reply and a question I should ask.",
			recentMessages: [],
			channel: "telegram",
		});
		expect(context).toBeDefined();
		expect(context).toContain('Avoid: "I noticed", "as an AI"');
		expect(context).toContain("Zero or one emoji max");
		expect(context).toContain("human judgment centered");
	});
});
