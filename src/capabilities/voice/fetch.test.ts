import { describe, expect, test } from "bun:test";
import { fetchVoiceBytes } from "./fetch";

describe("fetchVoiceBytes", () => {
	test("downloads Telegram-hosted voice bytes", async () => {
		const result = await fetchVoiceBytes(
			{ file_path: "voice/file_1.ogg" },
			"token-123",
			(async (input) => {
				expect(String(input)).toBe(
					"https://api.telegram.org/file/bottoken-123/voice/file_1.ogg",
				);
				return new Response(Uint8Array.from([7, 8, 9]), { status: 200 });
			}) as typeof fetch,
		);

		expect(result).toEqual({
			data: Uint8Array.from([7, 8, 9]),
			filePath: "voice/file_1.ogg",
		});
	});

	test("rejects files without a download path", async () => {
		await expect(fetchVoiceBytes({ file_path: "" }, "token-123")).rejects.toThrow(
			"Telegram did not return a downloadable file path.",
		);
	});

	test("surfaces Telegram download failures", async () => {
		await expect(
			fetchVoiceBytes(
				{ file_path: "voice/file_1.ogg" },
				"token-123",
				(async () => new Response("nope", { status: 502 })) as unknown as typeof fetch,
			),
		).rejects.toThrow("Telegram file download failed with status 502.");
	});
});
