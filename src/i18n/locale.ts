export const SUPPORTED_LOCALES = ["en", "ru", "es"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_STATUS_LOCALE: SupportedLocale = "en";

export function resolveLocale(
	hint: string | null | undefined,
	configDefault?: SupportedLocale,
): SupportedLocale {
	const normalized = normalizeLocaleHint(hint);
	if (normalized !== null && isSupportedLocale(normalized)) {
		return normalized;
	}
	if (configDefault !== undefined && isSupportedLocale(configDefault)) {
		return configDefault;
	}
	return DEFAULT_STATUS_LOCALE;
}

function isSupportedLocale(value: string): value is SupportedLocale {
	return SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

function normalizeLocaleHint(hint: string | null | undefined): string | null {
	if (hint === null || hint === undefined) {
		return null;
	}
	const trimmed = hint.trim().toLowerCase();
	if (trimmed === "") {
		return null;
	}
	const regionStripped = trimmed.split("-")[0].split("_")[0];
	return regionStripped || null;
}

export function extractLocaleFromTelegram(
	languageCode: string | null | undefined,
): string | null {
	return normalizeLocaleHint(languageCode);
}

export function extractLocaleFromCli(): string | null {
	const lang = process.env.LC_ALL ?? process.env.LANG ?? null;
	return normalizeLocaleHint(lang);
}

// Localized strings for turn-lifecycle events (not tool invocations — those
// use the allowlisted templates in src/tools/status_templates.ts).
const LIFECYCLE_STATUS: Record<SupportedLocale, { compacting: string }> = {
	en: { compacting: "Compacting context…" },
	ru: { compacting: "Сжимаю контекст…" },
	es: { compacting: "Compactando contexto…" },
};

export function compactionStatusMessage(
	locale: SupportedLocale | undefined,
): string {
	const effective = locale ?? DEFAULT_STATUS_LOCALE;
	return (LIFECYCLE_STATUS[effective] ?? LIFECYCLE_STATUS.en).compacting;
}
