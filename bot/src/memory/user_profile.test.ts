import { describe, expect, test } from "bun:test";
import {
	composeUserProfile,
	DEFAULT_PROACTIVE_PREFERENCES,
	isStructuredUserProfile,
	normalizeUserProfile,
	parseProactivePreferencesFromUserProfile,
	upsertProactivePreferencesInUserProfile,
	userProfileIsEmpty,
} from "./user_profile";

describe("user profile proactive preferences", () => {
	test("keeps proactive preference defaults conservative for Telegram nudges", () => {
		expect(DEFAULT_PROACTIVE_PREFERENCES).toEqual({
			timezone: null,
			quietHours: {
				enabled: true,
				startLocalTime: "21:00",
				endLocalTime: "09:00",
			},
			digestLocalTime: "09:00",
			maxNudgesPerDay: 1,
			pushiness: "minimal",
			feedback: {
				lessLikeThis: [],
			},
		});
	});

	test("does not inject proactive preference defaults into empty USER.md", () => {
		const profile = composeUserProfile();

		expect(isStructuredUserProfile(profile)).toBe(true);
		expect(userProfileIsEmpty(profile)).toBe(true);
		expect(profile).toContain("## Preferences");
		expect(profile).not.toContain("maxNudgesPerDay");
		expect(profile).not.toContain("quietHours");
	});

	test("preserves existing structured profile content during normalization", () => {
		const profile = normalizeUserProfile(
			[
				"# USER.md",
				"",
				"## Preferences",
				"Timezone: America/New_York.",
				"Prefers quiet mornings.",
				"",
				"## Environment",
				"Uses Telegram.",
			].join("\n"),
		);

		expect(profile).toContain("## Profile");
		expect(profile).toContain("## Preferences");
		expect(profile).toContain("Timezone: America/New_York.");
		expect(profile).toContain("Prefers quiet mornings.");
		expect(profile).toContain("## Environment");
		expect(profile).toContain("Uses Telegram.");
		expect(profile).toContain("## Constraints");
		expect(profile).toContain("## Open Questions");
	});

	test("persists proactive preferences in the USER.md Preferences section", () => {
		const existing = composeUserProfile({
			Preferences: "Prefers quiet mornings.",
		});
		const preferences = {
			...DEFAULT_PROACTIVE_PREFERENCES,
			timezone: "America/New_York",
			feedback: {
				lessLikeThis: [
					{
						topic: "invoice follow-up",
						recordedAt: "2026-04-30T15:00:00.000Z",
					},
				],
			},
		};

		const updated = upsertProactivePreferencesInUserProfile(
			existing,
			preferences,
		);

		expect(updated).toContain("## Preferences");
		expect(updated).toContain("Prefers quiet mornings.");
		expect(updated).toContain("proactive-preferences:start");
		expect(parseProactivePreferencesFromUserProfile(updated)).toEqual(
			preferences,
		);
	});

	test("falls back to defaults when USER.md has no proactive preferences block", () => {
		const profile = composeUserProfile({
			Preferences: "Prefers quiet mornings.",
		});

		expect(parseProactivePreferencesFromUserProfile(profile)).toEqual(
			DEFAULT_PROACTIVE_PREFERENCES,
		);
	});
});
