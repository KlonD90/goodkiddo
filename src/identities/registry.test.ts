import { describe, expect, test } from "bun:test";
import {
	DEFAULT_IDENTITY_ID,
	listPresets,
	normalizeId,
	resolveDefaultPreset,
	resolveIdentityPrompt,
	resolvePreset,
} from "./registry";

describe("listPresets", () => {
	test("returns all curated presets", () => {
		const presets = listPresets();
		expect(presets.length).toBeGreaterThanOrEqual(3);
	});

	test("includes good_kiddo, do_it_doggo, business_doggo", () => {
		const ids = listPresets().map((p) => p.id);
		expect(ids).toContain("good_kiddo");
		expect(ids).toContain("do_it_doggo");
		expect(ids).toContain("business_doggo");
	});

	test("returns a stable order on repeated calls", () => {
		expect(listPresets().map((p) => p.id)).toEqual(
			listPresets().map((p) => p.id),
		);
	});

	test("each preset has non-empty id, label, description, and prompt", () => {
		for (const preset of listPresets()) {
			expect(preset.id.length).toBeGreaterThan(0);
			expect(preset.label.length).toBeGreaterThan(0);
			expect(preset.description.length).toBeGreaterThan(0);
			expect(preset.prompt.length).toBeGreaterThan(0);
		}
	});

	test("returns a copy — mutations do not affect the registry", () => {
		const first = listPresets();
		first.push({ id: "injected", label: "x", description: "x", prompt: "x" });
		expect(listPresets()).toHaveLength(first.length - 1);
	});
});

describe("resolveDefaultPreset", () => {
	test("returns a preset with the default id", () => {
		const preset = resolveDefaultPreset();
		expect(preset.id).toBe(DEFAULT_IDENTITY_ID);
	});

	test("default preset has a non-empty prompt", () => {
		expect(resolveDefaultPreset().prompt.length).toBeGreaterThan(0);
	});
});

describe("resolvePreset", () => {
	test("resolves a known id", () => {
		const preset = resolvePreset("good_kiddo");
		expect(preset).not.toBeNull();
		expect(preset?.id).toBe("good_kiddo");
	});

	test("returns null for unknown id", () => {
		expect(resolvePreset("nope")).toBeNull();
		expect(resolvePreset("unknown_identity")).toBeNull();
	});

	test("all presets from listPresets() resolve by their own id", () => {
		for (const preset of listPresets()) {
			expect(resolvePreset(preset.id)).not.toBeNull();
		}
	});
});

describe("normalizeId", () => {
	test("lowercases input", () => {
		expect(normalizeId("DO_IT_DOGGO")).toBe("do_it_doggo");
	});

	test("replaces hyphens with underscores", () => {
		expect(normalizeId("do-it-doggo")).toBe("do_it_doggo");
	});

	test("replaces spaces with underscores", () => {
		expect(normalizeId("good kiddo")).toBe("good_kiddo");
	});

	test("trims whitespace", () => {
		expect(normalizeId("  good_kiddo  ")).toBe("good_kiddo");
	});

	test("resolvePreset uses normalization — hyphen variant resolves", () => {
		expect(resolvePreset("good-kiddo")).not.toBeNull();
		expect(resolvePreset("GOOD_KIDDO")).not.toBeNull();
		expect(resolvePreset("do-it-doggo")).not.toBeNull();
	});
});

describe("resolveIdentityPrompt", () => {
	test("null stored id returns default without fallback flag", () => {
		const { preset, wasFallback } = resolveIdentityPrompt(null);
		expect(preset.id).toBe(DEFAULT_IDENTITY_ID);
		expect(wasFallback).toBe(false);
	});

	test("undefined stored id returns default without fallback flag", () => {
		const { preset, wasFallback } = resolveIdentityPrompt(undefined);
		expect(preset.id).toBe(DEFAULT_IDENTITY_ID);
		expect(wasFallback).toBe(false);
	});

	test("stale/unknown stored id returns default with fallback flag", () => {
		const { preset, wasFallback } = resolveIdentityPrompt("removed_preset");
		expect(preset.id).toBe(DEFAULT_IDENTITY_ID);
		expect(wasFallback).toBe(true);
	});

	test("known stored id returns that preset without fallback flag", () => {
		const { preset, wasFallback } = resolveIdentityPrompt("do_it_doggo");
		expect(preset.id).toBe("do_it_doggo");
		expect(wasFallback).toBe(false);
	});
});
