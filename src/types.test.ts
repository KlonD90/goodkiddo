import { describe, expect, test } from "bun:test";
import {
	checkAiType,
	checkUsingMode,
	type SupportedAiTypes,
	type UsingMode,
} from "./types";

describe("checkAiType", () => {
	test("accepts supported AI types", () => {
		expect(checkAiType("anthropic")).toBe(true);
		expect(checkAiType("openai")).toBe(true);
		expect(checkAiType("openrouter")).toBe(true);
	});

	test("rejects unsupported AI types", () => {
		expect(checkAiType("")).toBe(false);
		expect(checkAiType("claude")).toBe(false);
		expect(checkAiType("gpt")).toBe(false);
	});

	test("narrows strings to SupportedAiTypes", () => {
		const value = "openai" as string;

		if (!checkAiType(value)) {
			throw new Error("expected value to be supported");
		}

		const narrowed: SupportedAiTypes = value;
		expect(narrowed).toBe("openai");
	});
});

describe("checkUsingMode", () => {
	test("accepts supported using modes", () => {
		expect(checkUsingMode("single")).toBe(true);
		expect(checkUsingMode("multi")).toBe(true);
	});

	test("rejects unsupported using modes", () => {
		expect(checkUsingMode("")).toBe(false);
		expect(checkUsingMode("solo")).toBe(false);
		expect(checkUsingMode("parallel")).toBe(false);
	});

	test("narrows strings to UsingMode", () => {
		const value = "multi" as string;

		if (!checkUsingMode(value)) {
			throw new Error("expected value to be supported");
		}

		const narrowed: UsingMode = value;
		expect(narrowed).toBe("multi");
	});
});
