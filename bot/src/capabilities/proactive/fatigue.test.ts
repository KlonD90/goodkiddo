import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PROACTIVE_PREFERENCES,
	type ProactivePreferences,
} from "../../memory/user_profile";
import { decideProactiveFatigue } from "./fatigue";

function preferences(
	overrides: Partial<ProactivePreferences> = {},
): ProactivePreferences {
	return {
		...DEFAULT_PROACTIVE_PREFERENCES,
		timezone: "America/New_York",
		...overrides,
		quietHours: {
			...DEFAULT_PROACTIVE_PREFERENCES.quietHours,
			...overrides.quietHours,
		},
	};
}

describe("proactive fatigue decisions", () => {
	test("sends when a prepared follow-up is within preferences", () => {
		const decision = decideProactiveFatigue({
			preferences: preferences(),
			now: new Date("2026-04-30T14:00:00.000Z"),
			recentNudgeCountToday: 0,
		});

		expect(decision).toEqual({
			action: "send",
			reason: "within_preferences",
		});
	});

	test("batches during quiet hours until the quiet period ends", () => {
		const decision = decideProactiveFatigue({
			preferences: preferences(),
			now: new Date("2026-05-01T02:30:00.000Z"),
			recentNudgeCountToday: 0,
		});

		expect(decision.action).toBe("batch");
		expect(decision.reason).toBe("quiet_hours");
		if (decision.action === "batch") {
			expect(decision.batchAfterUtc?.toISOString()).toBe(
				"2026-05-01T13:00:00.000Z",
			);
		}
	});

	test("suppresses proactive follow-ups after the daily nudge limit", () => {
		const decision = decideProactiveFatigue({
			preferences: preferences({ maxNudgesPerDay: 1 }),
			now: new Date("2026-04-30T15:00:00.000Z"),
			recentNudgeCountToday: 1,
		});

		expect(decision).toEqual({
			action: "suppress",
			reason: "daily_limit_reached",
		});
	});

	test("sends explicit user-requested reminders despite quiet hours and limits", () => {
		const decision = decideProactiveFatigue({
			preferences: preferences({ maxNudgesPerDay: 1 }),
			now: new Date("2026-05-01T02:30:00.000Z"),
			recentNudgeCountToday: 10,
			source: "user_requested_reminder",
		});

		expect(decision).toEqual({
			action: "send",
			reason: "explicit_user_request",
		});
	});

	test("batches when quiet hours are enabled but timezone is unknown", () => {
		const decision = decideProactiveFatigue({
			preferences: preferences({ timezone: null }),
			now: new Date("2026-04-30T15:00:00.000Z"),
			recentNudgeCountToday: 0,
		});

		expect(decision).toEqual({
			action: "batch",
			reason: "timezone_unknown",
			batchAfterUtc: null,
		});
	});
});
