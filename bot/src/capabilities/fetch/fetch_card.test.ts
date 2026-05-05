import { describe, expect, test } from "bun:test";
import { formatFetchCard } from "./fetch_card";

describe("formatFetchCard", () => {
	test("formats a normal fetch card", () => {
		expect(
			formatFetchCard({
				noticed: "Design review is waiting on the mobile layout decision.",
				prepared: "summary with the remaining layout choices",
				missing: "mobile breakpoint preference",
				source: "direct ask",
				body: "Option A keeps the checkout compact.\nOption B gives the promo field more room.",
			}),
		).toBe(`🐶 Fetched
Noticed: Design review is waiting on the mobile layout decision.
Prepared: summary with the remaining layout choices
Missing: mobile breakpoint preference
Source: direct ask

Option A keeps the checkout compact.
Option B gives the promo field more room.`);
	});

	test("renders Missing: none when missing is absent, null, or blank", () => {
		const baseInput = {
			noticed: "The rollout note still needs a final owner.",
			prepared: "brief status card",
			source: "recent chat",
			body: "The release is otherwise ready.",
		};
		const expected = `🐶 Fetched
Noticed: The rollout note still needs a final owner.
Prepared: brief status card
Missing: none
Source: recent chat

The release is otherwise ready.`;

		expect(formatFetchCard(baseInput)).toBe(expected);
		expect(formatFetchCard({ ...baseInput, missing: null })).toBe(expected);
		expect(formatFetchCard({ ...baseInput, missing: "   " })).toBe(expected);
	});

	test("preserves multiline body after one blank line following source", () => {
		const output = formatFetchCard({
			noticed: "Invoice reconciliation is unfinished.",
			prepared: "checklist with next steps",
			missing: "",
			source: "forwarded case",
			body: "1. Match Stripe payout.\n\n2. Confirm tax category.\n3. Send note.",
		});

		expect(output).toBe(`🐶 Fetched
Noticed: Invoice reconciliation is unfinished.
Prepared: checklist with next steps
Missing: none
Source: forwarded case

1. Match Stripe payout.

2. Confirm tax category.
3. Send note.`);
	});

	test("does not add approval-flow or dangerous-action wording", () => {
		const output = formatFetchCard({
			noticed: "The backup audit has an open follow-up.",
			prepared: "short audit note",
			source: "public source",
			body: "Backups completed at 03:00 UTC.",
		});

		expect(output.toLowerCase()).not.toContain("approval");
		expect(output.toLowerCase()).not.toContain("approve");
		expect(output.toLowerCase()).not.toContain("dangerous");
		expect(output.toLowerCase()).not.toContain("action required");
	});
});
