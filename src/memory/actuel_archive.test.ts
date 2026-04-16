import { describe, expect, test } from "bun:test";
import {
	applyReplace,
	applyRotate,
	composeFresh,
	currentActuel,
} from "./actuel_archive";

describe("actuel_archive", () => {
	test("composeFresh lays out header + Actuel", () => {
		const out = composeFresh("# Title", "first body");
		expect(out).toContain("# Title");
		expect(out).toContain("## Actuel");
		expect(out).toContain("first body");
		expect(out).not.toContain("## Archive");
	});

	test("applyReplace overwrites Actuel, preserves header and Archive", () => {
		const seed = composeFresh("# Title", "original body");
		const rotated = applyRotate(seed, "v2 body", "2026-04-16");
		const replaced = applyReplace(rotated, "v3 body");

		expect(currentActuel(replaced)).toBe("v3 body");
		expect(replaced).toContain("### [2026-04-16]");
		expect(replaced).toContain("original body");
		expect(replaced).toContain("# Title");
	});

	test("applyRotate moves previous Actuel into Archive", () => {
		const seed = composeFresh("# Title", "v1");
		const afterRotate = applyRotate(seed, "v2", "2026-04-16");

		expect(currentActuel(afterRotate)).toBe("v2");
		expect(afterRotate).toContain("## Archive");
		expect(afterRotate).toContain("### [2026-04-16]");
		expect(afterRotate).toContain("v1");
	});

	test("multiple rotates stack Archive entries chronologically", () => {
		let content = composeFresh("# Title", "v1");
		content = applyRotate(content, "v2", "2026-04-10");
		content = applyRotate(content, "v3", "2026-04-16");

		expect(currentActuel(content)).toBe("v3");
		const v16Idx = content.indexOf("### [2026-04-16]");
		const v10Idx = content.indexOf("### [2026-04-10]");
		expect(v16Idx).toBeGreaterThan(-1);
		expect(v10Idx).toBeGreaterThan(-1);
		expect(v16Idx).toBeLessThan(v10Idx); // newer first
		expect(content).toContain("v1");
		expect(content).toContain("v2");
	});

	test("rotate on fresh file (no prior Actuel content) produces Actuel only", () => {
		const afterRotate = applyRotate("# Title\n", "first body", "2026-04-16");
		expect(currentActuel(afterRotate)).toBe("first body");
		expect(afterRotate).not.toContain("## Archive");
	});
});
