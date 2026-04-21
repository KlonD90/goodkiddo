import { describe, expect, test } from "bun:test";
import {
	DEFAULT_STATUS_LOCALE,
	SUPPORTED_LOCALES,
	extractLocaleFromCli,
	extractLocaleFromTelegram,
	resolveLocale,
} from "./locale";

describe("locale resolution", () => {
	describe("SUPPORTED_LOCALES", () => {
		test("contains en, ru, es", () => {
			expect(SUPPORTED_LOCALES).toEqual(["en", "ru", "es"]);
		});
	});

	describe("resolveLocale", () => {
		test("returns exact match for supported locale", () => {
			expect(resolveLocale("en")).toBe("en");
			expect(resolveLocale("ru")).toBe("ru");
			expect(resolveLocale("es")).toBe("es");
		});

		test("case insensitive matching", () => {
			expect(resolveLocale("EN")).toBe("en");
			expect(resolveLocale("RU")).toBe("ru");
			expect(resolveLocale("ES")).toBe("es");
			expect(resolveLocale("En")).toBe("en");
			expect(resolveLocale("Ru")).toBe("ru");
			expect(resolveLocale("Es")).toBe("es");
		});

		test("strips region code (ISO format es-MX)", () => {
			expect(resolveLocale("es-MX")).toBe("es");
			expect(resolveLocale("en-US")).toBe("en");
			expect(resolveLocale("ru-RU")).toBe("ru");
		});

		test("strips region code (POSIX format en_US)", () => {
			expect(resolveLocale("en_US")).toBe("en");
			expect(resolveLocale("es_MX")).toBe("es");
			expect(resolveLocale("ru_RU")).toBe("ru");
		});

		test("falls back to config default when hint is unknown locale", () => {
			expect(resolveLocale("fr", "es")).toBe("es");
			expect(resolveLocale("de", "ru")).toBe("ru");
			expect(resolveLocale("zh", "en")).toBe("en");
		});

		test("falls back to DEFAULT_STATUS_LOCALE when config default is not a supported locale", () => {
			expect(resolveLocale("fr", "invalid" as "en")).toBe(DEFAULT_STATUS_LOCALE);
		});

		test("falls back to DEFAULT_STATUS_LOCALE when hint is unknown and no config default", () => {
			expect(resolveLocale("fr")).toBe(DEFAULT_STATUS_LOCALE);
			expect(resolveLocale("de")).toBe(DEFAULT_STATUS_LOCALE);
			expect(resolveLocale("zh")).toBe(DEFAULT_STATUS_LOCALE);
			expect(resolveLocale("xyz")).toBe(DEFAULT_STATUS_LOCALE);
		});

		test("handles null and undefined hint", () => {
			expect(resolveLocale(null)).toBe(DEFAULT_STATUS_LOCALE);
			expect(resolveLocale(undefined)).toBe(DEFAULT_STATUS_LOCALE);
		});

		test("handles empty string hint", () => {
			expect(resolveLocale("")).toBe(DEFAULT_STATUS_LOCALE);
			expect(resolveLocale("   ")).toBe(DEFAULT_STATUS_LOCALE);
		});

		test("never throws on malformed input", () => {
			expect(() => resolveLocale("")).not.toThrow();
			expect(() => resolveLocale("   ")).not.toThrow();
			expect(() => resolveLocale(null)).not.toThrow();
			expect(() => resolveLocale(undefined)).not.toThrow();
			expect(() => resolveLocale("not-a-locale-at-all")).not.toThrow();
			expect(() => resolveLocale("es-MX")).not.toThrow();
		});
	});

	describe("extractLocaleFromTelegram", () => {
		test("returns normalized locale from Telegram language_code", () => {
			expect(extractLocaleFromTelegram("en")).toBe("en");
			expect(extractLocaleFromTelegram("ru")).toBe("ru");
			expect(extractLocaleFromTelegram("es")).toBe("es");
		});

		test("strips region from Telegram language_code", () => {
			expect(extractLocaleFromTelegram("es-MX")).toBe("es");
			expect(extractLocaleFromTelegram("en-US")).toBe("en");
		});

		test("returns null for null/undefined/empty", () => {
			expect(extractLocaleFromTelegram(null)).toBeNull();
			expect(extractLocaleFromTelegram(undefined)).toBeNull();
			expect(extractLocaleFromTelegram("")).toBeNull();
		});

		test("case insensitive", () => {
			expect(extractLocaleFromTelegram("EN")).toBe("en");
			expect(extractLocaleFromTelegram("Es")).toBe("es");
		});
	});

	describe("extractLocaleFromCli", () => {
		test("returns null when LANG and LC_ALL are not set", () => {
			const originalLang = process.env.LANG;
			const originalLcAll = process.env.LC_ALL;
			try {
				delete process.env.LANG;
				delete process.env.LC_ALL;
				expect(extractLocaleFromCli()).toBeNull();
			} finally {
				if (originalLang !== undefined) process.env.LANG = originalLang;
				if (originalLcAll !== undefined) process.env.LC_ALL = originalLcAll;
			}
		});

		test("extracts locale from LANG environment variable", () => {
			const originalLang = process.env.LANG;
			try {
				process.env.LANG = "en_US.UTF-8";
				expect(extractLocaleFromCli()).toBe("en");
			} finally {
				if (originalLang !== undefined) process.env.LANG = originalLang;
			}
		});

		test("extracts locale from LC_ALL environment variable", () => {
			const originalLcAll = process.env.LC_ALL;
			const originalLang = process.env.LANG;
			try {
				process.env.LC_ALL = "es_MX.UTF-8";
				delete process.env.LANG;
				expect(extractLocaleFromCli()).toBe("es");
			} finally {
				if (originalLcAll !== undefined) process.env.LC_ALL = originalLcAll;
				if (originalLang !== undefined) process.env.LANG = originalLang;
			}
		});

		test("LC_ALL takes precedence over LANG", () => {
			const originalLcAll = process.env.LC_ALL;
			const originalLang = process.env.LANG;
			try {
				process.env.LC_ALL = "ru_RU.UTF-8";
				process.env.LANG = "en_US.UTF-8";
				expect(extractLocaleFromCli()).toBe("ru");
			} finally {
				if (originalLcAll !== undefined) process.env.LC_ALL = originalLcAll;
				if (originalLang !== undefined) process.env.LANG = originalLang;
			}
		});
	});
});