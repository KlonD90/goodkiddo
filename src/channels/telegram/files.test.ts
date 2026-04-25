import { describe, expect, test } from "bun:test";
import {
	buildIncomingImagePromptText,
	extractIncomingExtension,
} from "./files";

describe("extractIncomingExtension", () => {
	test("extracts known image extensions in lowercase", () => {
		expect(extractIncomingExtension("photos/file.PNG")).toBe("png");
		expect(extractIncomingExtension("file.webp")).toBe("webp");
		expect(extractIncomingExtension("file.gif")).toBe("gif");
	});

	test("falls back to jpg for unknown or missing extensions", () => {
		expect(extractIncomingExtension(undefined)).toBe("jpg");
		expect(extractIncomingExtension("")).toBe("jpg");
		expect(extractIncomingExtension("file")).toBe("jpg");
		expect(extractIncomingExtension("file.tiff")).toBe("jpg");
	});

	test("falls back to jpg for paths with unsafe characters in extension", () => {
		expect(extractIncomingExtension("file.png;rm")).toBe("jpg");
	});
});

describe("buildIncomingImagePromptText", () => {
	test("includes the caption when one was provided", () => {
		const text = buildIncomingImagePromptText(
			"/incoming/123-abc.jpg",
			"what does this say?",
		);
		expect(text).toContain("/incoming/123-abc.jpg");
		expect(text).toContain('Caption: "what does this say?"');
		expect(text).toContain("understand_image");
	});

	test("omits the caption clause when caption is empty", () => {
		const text = buildIncomingImagePromptText("/incoming/x.jpg", "");
		expect(text).not.toContain("Caption:");
		expect(text).toContain("/incoming/x.jpg");
		expect(text).toContain("understand_image");
	});

	test("trims whitespace-only captions", () => {
		const text = buildIncomingImagePromptText("/incoming/x.jpg", "   ");
		expect(text).not.toContain("Caption:");
	});
});
