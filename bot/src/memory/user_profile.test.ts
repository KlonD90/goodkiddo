import { describe, expect, test } from "bun:test";
import {
	composeUserProfile,
	DEFAULT_PROACTIVE_PREFERENCES,
	isStructuredUserProfile,
	normalizeUserProfile,
	PROACTIVE_PREFERENCES_PROFILE_SECTION,
	userProfileIsEmpty,
} from "./user_profile";

describe("user profile proactive preferences", () => {
	test("keeps proactive preference defaults conservative for Telegram nudges", () => {
		expect(PROACTIVE_PREFERENCES_PROFILE_SECTION).toBe("Preferences");
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
		const profile = normalizeUserProfile([
			"# USER.md",
			"",
			"## Preferences",
			"Timezone: America/New_York.",
			"Prefers quiet mornings.",
			"",
			"## Environment",
			"Uses Telegram.",
		].join("\n"));

		expect(profile).toContain("## Profile");
		expect(profile).toContain("## Preferences");
		expect(profile).toContain("Timezone: America/New_York.");
		expect(profile).toContain("Prefers quiet mornings.");
		expect(profile).toContain("## Environment");
		expect(profile).toContain("Uses Telegram.");
		expect(profile).toContain("## Constraints");
		expect(profile).toContain("## Open Questions");
	});
});
