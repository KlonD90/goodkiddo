import { describe, expect, test } from "bun:test";
import { fetchTelegramFileBytes } from "./fetch";

describe("fetchTelegramFileBytes", () => {
	test("downloads Telegram-hosted document bytes", async () => {
		const result = await fetchTelegramFileBytes(
			{ file_path: "documents/file_1.pdf" },
			"token-123",
			(async (input) => {
				expect(String(input)).toBe(
					"https://api.telegram.org/file/bottoken-123/documents/file_1.pdf",
				);
				return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
			}) as typeof fetch,
		);

		expect(result).toEqual({
			data: Uint8Array.from([1, 2, 3]),
			filePath: "documents/file_1.pdf",
		});
	});

	test("rejects files without a download path", async () => {
		await expect(fetchTelegramFileBytes({ file_path: "" }, "token-123")).rejects.toThrow(
			"Telegram did not return a downloadable file path.",
		);
	});

	test("surfaces Telegram download failures", async () => {
		await expect(
			fetchTelegramFileBytes(
				{ file_path: "documents/file_1.pdf" },
				"token-123",
				(async () => new Response("nope", { status: 502 })) as unknown as typeof fetch,
			),
		).rejects.toThrow("Telegram file download failed with status 502.");
	});
});