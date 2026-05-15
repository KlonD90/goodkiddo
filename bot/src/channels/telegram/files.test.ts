import { describe, expect, test } from "bun:test";
import {
	buildIncomingImagePromptText,
	buildTelegramPhotoUserInput,
	extractIncomingExtension,
} from "./files";

const BASE_CONFIG = {
	enableImageUnderstanding: false,
	minimaxApiKey: "",
} as const;

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
	test("includes saved path, caption, and understand_image guidance", () => {
		const prompt = buildIncomingImagePromptText(
			"/incoming/photo.png",
			"what does this say?",
		);

		expect(prompt).toContain("/incoming/photo.png");
		expect(prompt).toContain('Caption: "what does this say?"');
		expect(prompt).toContain("understand_image");
	});

	test("omits caption line for blank captions", () => {
		const prompt = buildIncomingImagePromptText("/incoming/photo.jpg", "  ");

		expect(prompt).toContain("/incoming/photo.jpg");
		expect(prompt).not.toContain("Caption:");
	});
});

describe("buildTelegramPhotoUserInput", () => {
	test("keeps raw image content when image understanding is disabled", async () => {
		const bytes = Uint8Array.from([1, 2, 3]);
		const content = await buildTelegramPhotoUserInput(
			BASE_CONFIG as never,
			{} as never,
			bytes,
			{
				caption: "describe this",
				filePath: "photos/file.PNG",
			},
		);

		expect(content).toEqual([
			{ type: "text", text: "describe this" },
			{ type: "image", mimeType: "image/png", data: bytes },
		]);
	});
});
