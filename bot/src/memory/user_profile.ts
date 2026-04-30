import { currentActuel } from "./actuel_archive";

export const USER_PROFILE_SECTIONS = [
	"Profile",
	"Preferences",
	"Environment",
	"Constraints",
	"Open Questions",
] as const;

export type UserProfileSection = (typeof USER_PROFILE_SECTIONS)[number];

export type ProactivePushiness = "minimal" | "standard" | "assertive";

export type ProactiveQuietHours = {
	enabled: boolean;
	startLocalTime: string;
	endLocalTime: string;
};

export type ProactiveLessLikeThisSignal = {
	topic: string;
	recordedAt: string;
};

export type ProactiveFeedbackPreferences = {
	lessLikeThis: ProactiveLessLikeThisSignal[];
};

export type ProactivePreferences = {
	/**
	 * IANA timezone when the user has provided one. Keep null by default so
	 * Telegram nudges never silently assume the app/server timezone.
	 */
	timezone: string | null;
	quietHours: ProactiveQuietHours;
	digestLocalTime: string;
	maxNudgesPerDay: number;
	pushiness: ProactivePushiness;
	feedback: ProactiveFeedbackPreferences;
};

export const DEFAULT_PROACTIVE_PREFERENCES: ProactivePreferences = {
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
};

const EMPTY_SECTION_BODY = "_No durable facts recorded yet._";
const PROACTIVE_PREFERENCES_PROFILE_SECTION: UserProfileSection = "Preferences";
const PROACTIVE_PREFERENCES_BLOCK_START =
	"<!-- proactive-preferences:start -->";
const PROACTIVE_PREFERENCES_BLOCK_END = "<!-- proactive-preferences:end -->";
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function sectionHeading(section: UserProfileSection): string {
	return `## ${section}`;
}

function splitMarkdownSections(content: string): Map<string, string> {
	const sections = new Map<string, string>();
	const headingRegex = /^##\s+(.+?)\s*$/gm;
	const matches = [...content.matchAll(headingRegex)];
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		const next = matches[index + 1];
		if (match.index === undefined) continue;
		const title = (match[1] ?? "").trim();
		const bodyStart = match.index + match[0].length;
		const bodyEnd = next?.index ?? content.length;
		sections.set(title, content.slice(bodyStart, bodyEnd).trim());
	}
	return sections;
}

function cloneDefaultProactivePreferences(): ProactivePreferences {
	return {
		...DEFAULT_PROACTIVE_PREFERENCES,
		quietHours: { ...DEFAULT_PROACTIVE_PREFERENCES.quietHours },
		feedback: {
			lessLikeThis: [...DEFAULT_PROACTIVE_PREFERENCES.feedback.lessLikeThis],
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	return null;
}

function localTimeOr(value: unknown, fallback: string): string {
	return typeof value === "string" && LOCAL_TIME_PATTERN.test(value)
		? value
		: fallback;
}

function positiveIntegerOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: fallback;
}

function pushinessOr(value: unknown, fallback: ProactivePushiness) {
	return value === "minimal" || value === "standard" || value === "assertive"
		? value
		: fallback;
}

function lessLikeThisOr(value: unknown): ProactiveLessLikeThisSignal[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((signal) => {
		if (!isRecord(signal)) return [];
		const topic = typeof signal.topic === "string" ? signal.topic.trim() : "";
		const recordedAt =
			typeof signal.recordedAt === "string" ? signal.recordedAt.trim() : "";
		if (topic.length === 0 || recordedAt.length === 0) return [];
		return [{ topic, recordedAt }];
	});
}

function proactivePreferencesBlockRegex(): RegExp {
	const start = PROACTIVE_PREFERENCES_BLOCK_START.replace(
		/[.*+?^${}()|[\]\\]/g,
		"\\$&",
	);
	const end = PROACTIVE_PREFERENCES_BLOCK_END.replace(
		/[.*+?^${}()|[\]\\]/g,
		"\\$&",
	);
	return new RegExp(`${start}\\s*([\\s\\S]*?)\\s*${end}`);
}

export function normalizeProactivePreferences(
	value: unknown,
): ProactivePreferences {
	const defaults = cloneDefaultProactivePreferences();
	if (!isRecord(value)) return defaults;

	const quietHours = isRecord(value.quietHours) ? value.quietHours : {};
	const feedback = isRecord(value.feedback) ? value.feedback : {};

	return {
		timezone: stringOrNull(value.timezone),
		quietHours: {
			enabled:
				typeof quietHours.enabled === "boolean"
					? quietHours.enabled
					: defaults.quietHours.enabled,
			startLocalTime: localTimeOr(
				quietHours.startLocalTime,
				defaults.quietHours.startLocalTime,
			),
			endLocalTime: localTimeOr(
				quietHours.endLocalTime,
				defaults.quietHours.endLocalTime,
			),
		},
		digestLocalTime: localTimeOr(
			value.digestLocalTime,
			defaults.digestLocalTime,
		),
		maxNudgesPerDay: positiveIntegerOr(
			value.maxNudgesPerDay,
			defaults.maxNudgesPerDay,
		),
		pushiness: pushinessOr(value.pushiness, defaults.pushiness),
		feedback: {
			lessLikeThis: lessLikeThisOr(feedback.lessLikeThis),
		},
	};
}

export function parseProactivePreferencesFromUserProfile(
	content: string,
): ProactivePreferences {
	const normalized = normalizeUserProfile(content);
	const sections = splitMarkdownSections(normalized);
	const preferences = sections.get(PROACTIVE_PREFERENCES_PROFILE_SECTION) ?? "";
	const match = proactivePreferencesBlockRegex().exec(preferences);
	if (!match) return cloneDefaultProactivePreferences();
	try {
		return normalizeProactivePreferences(JSON.parse(match[1] ?? "{}"));
	} catch {
		return cloneDefaultProactivePreferences();
	}
}

export function upsertProactivePreferencesInUserProfile(
	content: string,
	preferences: ProactivePreferences,
): string {
	const normalized = normalizeUserProfile(content);
	const sections = splitMarkdownSections(normalized);
	const nextSections = Object.fromEntries(
		USER_PROFILE_SECTIONS.map((section) => [
			section,
			sections.get(section) ?? "",
		]),
	) as Partial<Record<UserProfileSection, string>>;
	const currentPreferences =
		nextSections[PROACTIVE_PREFERENCES_PROFILE_SECTION]?.trim() ?? "";
	const existingBody =
		currentPreferences === EMPTY_SECTION_BODY ? "" : currentPreferences;
	const block = [
		PROACTIVE_PREFERENCES_BLOCK_START,
		JSON.stringify(normalizeProactivePreferences(preferences), null, "\t"),
		PROACTIVE_PREFERENCES_BLOCK_END,
	].join("\n");
	const blockRegex = proactivePreferencesBlockRegex();

	nextSections[PROACTIVE_PREFERENCES_PROFILE_SECTION] = blockRegex.test(
		existingBody,
	)
		? existingBody.replace(blockRegex, block)
		: [existingBody, block].filter(Boolean).join("\n\n");

	return composeUserProfile(nextSections);
}

export function composeUserProfile(
	sections: Partial<Record<UserProfileSection, string>> = {},
): string {
	const lines: string[] = ["# USER.md"];
	for (const section of USER_PROFILE_SECTIONS) {
		const body = sections[section]?.trim() || EMPTY_SECTION_BODY;
		lines.push("", sectionHeading(section), body);
	}
	return `${lines.join("\n")}\n`;
}

export function isStructuredUserProfile(content: string): boolean {
	if (!content.trim().startsWith("# USER.md")) return false;
	const sections = splitMarkdownSections(content);
	return USER_PROFILE_SECTIONS.every((section) => sections.has(section));
}

export function userProfileIsEmpty(content: string): boolean {
	const sections = splitMarkdownSections(content);
	if (USER_PROFILE_SECTIONS.some((section) => !sections.has(section))) {
		const actuel = currentActuel(content);
		return actuel.length === 0 || actuel.startsWith("_No profile yet.");
	}
	return USER_PROFILE_SECTIONS.every((section) => {
		const body = sections.get(section)?.trim() ?? "";
		return body.length === 0 || body === EMPTY_SECTION_BODY;
	});
}

export function normalizeUserProfile(content: string): string {
	const trimmed = content.trim();
	if (trimmed.length === 0) return composeUserProfile();

	const sections = splitMarkdownSections(content);
	if (USER_PROFILE_SECTIONS.some((section) => sections.has(section))) {
		return composeUserProfile(
			Object.fromEntries(
				USER_PROFILE_SECTIONS.map((section) => [
					section,
					sections.get(section) ?? "",
				]),
			) as Partial<Record<UserProfileSection, string>>,
		);
	}

	const actuel = currentActuel(content);
	return composeUserProfile({
		Profile:
			actuel.length > 0
				? actuel
				: trimmed.replace(/^#\s*USER\.md\s*/i, "").trim(),
	});
}
