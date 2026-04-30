import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PROACTIVE_PREFERENCES,
	type ProactivePreferences,
} from "../../memory/user_profile";
import { decideProactiveFatigue, recordLessLikeThisSignal } from "./fatigue";

type PreferenceOverrides = Partial<
	Omit<ProactivePreferences, "quietHours" | "feedback">
> & {
	quietHours?: Partial<ProactivePreferences["quietHours"]>;
	feedback?: Partial<ProactivePreferences["feedback"]>;
};

function preferences(
	overrides: PreferenceOverrides = {},
): ProactivePreferences {
	return {
		...DEFAULT_PROACTIVE_PREFERENCES,
		timezone: "America/New_York",
		...overrides,
		quietHours: {
			...DEFAULT_PROACTIVE_PREFERENCES.quietHours,
			...overrides.quietHours,
		},
		feedback: {
			...DEFAULT_PROACTIVE_PREFERENCES.feedback,
			...overrides.feedback,
			lessLikeThis:
				overrides.feedback?.lessLikeThis ??
				DEFAULT_PROACTIVE_PREFERENCES.feedback.lessLikeThis,
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

	test("batches quiet-hour prepared follow-ups to the explicit digest time", () => {
		const decision = decideProactiveFatigue({
			preferences: preferences({ digestLocalTime: "10:30" }),
			now: new Date("2026-05-01T02:30:00.000Z"),
			recentNudgeCountToday: 0,
		});

		expect(decision.action).toBe("batch");
		expect(decision.reason).toBe("quiet_hours");
		if (decision.action === "batch") {
			expect(decision.batchAfterUtc?.toISOString()).toBe(
				"2026-05-01T14:30:00.000Z",
			);
		}
	});

	test("batches daytime quiet-hour windows until quiet hours end", () => {
		const decision = decideProactiveFatigue({
			preferences: preferences({
				quietHours: {
					startLocalTime: "12:00",
					endLocalTime: "13:00",
				},
				digestLocalTime: "12:30",
			}),
			now: new Date("2026-04-30T16:15:00.000Z"),
			recentNudgeCountToday: 0,
		});

		expect(decision.action).toBe("batch");
		expect(decision.reason).toBe("quiet_hours");
		if (decision.action === "batch") {
			expect(decision.batchAfterUtc?.toISOString()).toBe(
				"2026-04-30T17:00:00.000Z",
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

	test("suppresses proactive follow-ups at the daily limit before batching", () => {
		const decision = decideProactiveFatigue({
			preferences: preferences({ maxNudgesPerDay: 1, timezone: null }),
			now: new Date("2026-05-01T02:30:00.000Z"),
			recentNudgeCountToday: 1,
		});

		expect(decision).toEqual({
			action: "suppress",
			reason: "daily_limit_reached",
		});
	});

	test("sends when quiet hours are disabled and timezone is unknown", () => {
		const decision = decideProactiveFatigue({
			preferences: preferences({
				timezone: null,
				quietHours: { enabled: false },
			}),
			now: new Date("2026-04-30T15:00:00.000Z"),
			recentNudgeCountToday: 0,
		});

		expect(decision).toEqual({
			action: "send",
			reason: "within_preferences",
		});
	});

	test("sends explicit user-requested timers and reminders despite quiet hours and limits", () => {
		for (const source of [
			"user_requested_timer",
			"user_requested_reminder",
		] as const) {
			const decision = decideProactiveFatigue({
				preferences: preferences({ maxNudgesPerDay: 1 }),
				now: new Date("2026-05-01T02:30:00.000Z"),
				recentNudgeCountToday: 10,
				source,
			});

			expect(decision).toEqual({
				action: "send",
				reason: "explicit_user_request",
			});
		}
	});

	test("batches when quiet hours are enabled but timezone is missing", () => {
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

	test("batches when quiet hours are enabled but timezone is invalid", () => {
		const decision = decideProactiveFatigue({
			preferences: preferences({ timezone: "Mars/Base" }),
			now: new Date("2026-04-30T15:00:00.000Z"),
			recentNudgeCountToday: 0,
		});

		expect(decision).toEqual({
			action: "batch",
			reason: "timezone_unknown",
			batchAfterUtc: null,
		});
	});

	test("records less-like-this feedback without deleting existing signals", () => {
		const existing = preferences({
			feedback: {
				lessLikeThis: [
					{
						topic: "invoice follow-up",
						recordedAt: "2026-04-29T15:00:00.000Z",
					},
				],
			},
		});

		const updated = recordLessLikeThisSignal({
			preferences: existing,
			topic: "sales outreach",
			now: new Date("2026-04-30T15:00:00.000Z"),
		});

		expect(updated.feedback.lessLikeThis).toEqual([
			{
				topic: "invoice follow-up",
				recordedAt: "2026-04-29T15:00:00.000Z",
			},
			{
				topic: "sales outreach",
				recordedAt: "2026-04-30T15:00:00.000Z",
			},
		]);
		expect(existing.feedback.lessLikeThis).toHaveLength(1);
	});

	test("suppresses future prepared follow-ups after less-like-this feedback", () => {
		const updated = recordLessLikeThisSignal({
			preferences: preferences(),
			topic: "Invoice follow-up",
			now: new Date("2026-04-30T15:00:00.000Z"),
		});

		const decision = decideProactiveFatigue({
			preferences: updated,
			now: new Date("2026-05-01T15:00:00.000Z"),
			recentNudgeCountToday: 0,
			topic: " invoice   follow-up ",
		});

		expect(decision).toEqual({
			action: "suppress",
			reason: "less_like_this",
		});
	});

	test("does not apply less-like-this feedback to explicit reminders", () => {
		const updated = recordLessLikeThisSignal({
			preferences: preferences(),
			topic: "Invoice follow-up",
			now: new Date("2026-04-30T15:00:00.000Z"),
		});

		const decision = decideProactiveFatigue({
			preferences: updated,
			now: new Date("2026-05-01T15:00:00.000Z"),
			recentNudgeCountToday: 0,
			source: "user_requested_reminder",
			topic: "invoice follow-up",
		});

		expect(decision).toEqual({
			action: "send",
			reason: "explicit_user_request",
		});
	});
});
