import { currentActuel } from "./actuel_archive";

export const USER_PROFILE_SECTIONS = [
	"Profile",
	"Preferences",
	"Environment",
	"Constraints",
	"Open Questions",
] as const;

export type UserProfileSection = (typeof USER_PROFILE_SECTIONS)[number];

export const PROACTIVE_PREFERENCES_PROFILE_SECTION: UserProfileSection =
	"Preferences";

export type ProactivePushiness = "minimal" | "standard" | "assertive";

export type ProactiveQuietHours = {
	enabled: boolean;
	startLocalTime: string;
	endLocalTime: string;
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
};

const EMPTY_SECTION_BODY = "_No durable facts recorded yet._";

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
		Profile: actuel.length > 0 ? actuel : trimmed.replace(/^#\s*USER\.md\s*/i, "").trim(),
	});
}
