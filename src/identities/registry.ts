import BUSINESS_DOGGO from "./BUSINESS_DOGGO.md?raw";
import DO_IT_DOGGO from "./DO_IT_DOGGO.md?raw";
import GOOD_KIDDO from "./GOOD_KIDDO.md?raw";

export type IdentityPreset = {
	id: string;
	label: string;
	description: string;
	prompt: string;
};

export const DEFAULT_IDENTITY_ID = "good_kiddo";

// Curated registry — only presets listed here are visible to users.
// ECHO.md and other development prompts are intentionally excluded.
const REGISTRY: IdentityPreset[] = [
	{
		id: "good_kiddo",
		label: "Good Kiddo",
		description:
			"Friendly, patient helper — explains clearly, asks when unsure, great for non-coders.",
		prompt: GOOD_KIDDO,
	},
	{
		id: "do_it_doggo",
		label: "Do-It Doggo",
		description:
			"Action-first agent — executes fast, reports results, minimal narration.",
		prompt: DO_IT_DOGGO,
	},
	{
		id: "business_doggo",
		label: "Business Doggo",
		description:
			"Proactive strategist — analyzes every turn, builds frameworks, schedules research autonomously.",
		prompt: BUSINESS_DOGGO,
	},
];

/** Normalize a raw preset id from user input or storage into a canonical form. */
export function normalizeId(id: string): string {
	return id.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

/** Returns a stable copy of the curated preset list. */
export function listPresets(): IdentityPreset[] {
	return REGISTRY.slice();
}

/** Returns the default preset. Always resolves — throws if registry is broken. */
export function resolveDefaultPreset(): IdentityPreset {
	const preset = REGISTRY.find((p) => p.id === DEFAULT_IDENTITY_ID);
	if (!preset) {
		throw new Error(
			`Default identity preset "${DEFAULT_IDENTITY_ID}" is missing from the registry.`,
		);
	}
	return preset;
}

/**
 * Resolve a preset by id. Returns null when the id is unknown or stale,
 * so callers can fall back to the default without crashing.
 */
export function resolvePreset(id: string): IdentityPreset | null {
	const normalized = normalizeId(id);
	return REGISTRY.find((p) => p.id === normalized) ?? null;
}

/**
 * Resolve the identity prompt for a given stored id.
 * Falls back to the default preset when the stored id is null, empty, or stale.
 */
export function resolveIdentityPrompt(storedId: string | null | undefined): {
	preset: IdentityPreset;
	wasFallback: boolean;
} {
	if (!storedId) {
		return { preset: resolveDefaultPreset(), wasFallback: false };
	}
	const preset = resolvePreset(storedId);
	if (!preset) {
		return { preset: resolveDefaultPreset(), wasFallback: true };
	}
	return { preset, wasFallback: false };
}
