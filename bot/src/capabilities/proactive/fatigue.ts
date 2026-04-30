import {
	DEFAULT_PROACTIVE_PREFERENCES,
	type ProactivePreferences,
} from "../../memory/user_profile";
import { isValidTimezone } from "../../utils/timezone";

export type ProactiveNudgeSource =
	| "prepared_follow_up"
	| "digest"
	| "user_requested_timer"
	| "user_requested_reminder";

export type ProactiveFatigueDecision =
	| {
			action: "send";
			reason: "within_preferences" | "explicit_user_request";
	  }
	| {
			action: "batch";
			reason: "quiet_hours" | "timezone_unknown";
			batchAfterUtc: Date | null;
	  }
	| {
			action: "suppress";
			reason: "daily_limit_reached" | "less_like_this";
	  };

export type ProactiveFatigueInput = {
	preferences?: ProactivePreferences;
	now?: Date;
	recentNudgeCountToday: number;
	source?: ProactiveNudgeSource;
	topic?: string;
};

export type RecordLessLikeThisInput = {
	preferences?: ProactivePreferences;
	topic: string;
	now?: Date;
};

type LocalTimeParts = {
	hour: number;
	minute: number;
};

const MINUTES_PER_DAY = 24 * 60;

export function decideProactiveFatigue(
	input: ProactiveFatigueInput,
): ProactiveFatigueDecision {
	const preferences = input.preferences ?? DEFAULT_PROACTIVE_PREFERENCES;
	const now = input.now ?? new Date();
	const source = input.source ?? "prepared_follow_up";

	if (isExplicitUserRequest(source)) {
		return { action: "send", reason: "explicit_user_request" };
	}

	if (input.topic && hasLessLikeThisSignal(preferences, input.topic)) {
		return { action: "suppress", reason: "less_like_this" };
	}

	if (input.recentNudgeCountToday >= preferences.maxNudgesPerDay) {
		return { action: "suppress", reason: "daily_limit_reached" };
	}

	if (preferences.quietHours.enabled) {
		if (!preferences.timezone || !isValidTimezone(preferences.timezone)) {
			return {
				action: "batch",
				reason: "timezone_unknown",
				batchAfterUtc: null,
			};
		}

		const localNow = localTimeParts(now, preferences.timezone);
		const quietStart = parseLocalTime(preferences.quietHours.startLocalTime);
		const quietEnd = parseLocalTime(preferences.quietHours.endLocalTime);
		if (isWithinQuietHours(localNow, quietStart, quietEnd)) {
			return {
				action: "batch",
				reason: "quiet_hours",
				batchAfterUtc: nextDigestTimeAfterQuietHoursUtc(
					now,
					preferences.timezone,
					preferences.quietHours.endLocalTime,
					preferences.digestLocalTime,
				),
			};
		}
	}

	return { action: "send", reason: "within_preferences" };
}

export function recordLessLikeThisSignal(
	input: RecordLessLikeThisInput,
): ProactivePreferences {
	const preferences = input.preferences ?? DEFAULT_PROACTIVE_PREFERENCES;
	const topic = normalizeSignalTopic(input.topic);
	if (topic.length === 0) return preferences;

	return {
		...preferences,
		quietHours: { ...preferences.quietHours },
		feedback: {
			...preferences.feedback,
			lessLikeThis: [
				...preferences.feedback.lessLikeThis,
				{
					topic,
					recordedAt: (input.now ?? new Date()).toISOString(),
				},
			],
		},
	};
}

function isExplicitUserRequest(source: ProactiveNudgeSource): boolean {
	return (
		source === "user_requested_timer" || source === "user_requested_reminder"
	);
}

function hasLessLikeThisSignal(
	preferences: ProactivePreferences,
	topic: string,
): boolean {
	const normalized = normalizeSignalTopic(topic);
	return preferences.feedback.lessLikeThis.some(
		(signal) => normalizeSignalTopic(signal.topic) === normalized,
	);
}

function normalizeSignalTopic(value: string): string {
	return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function localTimeParts(date: Date, timezone: string): LocalTimeParts {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(date);

	return {
		hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0),
		minute: Number(parts.find((part) => part.type === "minute")?.value ?? 0),
	};
}

function parseLocalTime(value: string): LocalTimeParts {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
	if (!match) {
		throw new Error(`Invalid local time: ${value}`);
	}
	return {
		hour: Number(match[1]),
		minute: Number(match[2]),
	};
}

function localTimeToMinutes(parts: LocalTimeParts): number {
	return parts.hour * 60 + parts.minute;
}

function isWithinQuietHours(
	localNow: LocalTimeParts,
	quietStart: LocalTimeParts,
	quietEnd: LocalTimeParts,
): boolean {
	const now = localTimeToMinutes(localNow);
	const start = localTimeToMinutes(quietStart);
	const end = localTimeToMinutes(quietEnd);
	if (start === end) return true;
	if (start < end) return now >= start && now < end;
	return now >= start || now < end;
}

function nextLocalTimeUtc(
	now: Date,
	timezone: string,
	localTime: string,
): Date | null {
	const target = parseLocalTime(localTime);
	for (let minutes = 1; minutes <= MINUTES_PER_DAY + 1; minutes++) {
		const candidate = new Date(now.getTime() + minutes * 60_000);
		const local = localTimeParts(candidate, timezone);
		if (local.hour === target.hour && local.minute === target.minute) {
			return candidate;
		}
	}
	return null;
}

function nextDigestTimeAfterQuietHoursUtc(
	now: Date,
	timezone: string,
	quietEndLocalTime: string,
	digestLocalTime: string,
): Date | null {
	const quietEnd = nextLocalTimeUtc(now, timezone, quietEndLocalTime);
	if (!quietEnd) return nextLocalTimeUtc(now, timezone, digestLocalTime);

	const quietEndParts = parseLocalTime(quietEndLocalTime);
	const digestParts = parseLocalTime(digestLocalTime);
	if (localTimeToMinutes(digestParts) < localTimeToMinutes(quietEndParts)) {
		return quietEnd;
	}

	const digest = nextLocalTimeUtc(now, timezone, digestLocalTime);
	if (!digest) return quietEnd;
	return digest.getTime() >= quietEnd.getTime() ? digest : quietEnd;
}
