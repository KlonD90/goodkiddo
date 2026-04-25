import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createMinimaxImageUnderstanding, type McpToolClient } from "./minimax_provider";

function createFakeClient(
	respond: (args: { prompt: string; image_url: string }) => unknown,
): {
	client: McpToolClient;
	calls: Array<{ prompt: string; image_url: string }>;
	closed: () => boolean;
} {
	const calls: Array<{ prompt: string; image_url: string }> = [];
	let closed = false;

	const client: McpToolClient = {
		async invokeUnderstandImage(args) {
			calls.push(args);
			return respond(args);
		},
		async close() {
			closed = true;
		},
	};

	return { client, calls, closed: () => closed };
}

describe("createMinimaxImageUnderstanding", () => {
	test("writes bytes to a temp file, invokes the MCP tool, returns normalized text", async () => {
		const fake = createFakeClient(({ image_url }) => {
			expect(existsSync(image_url)).toBe(true);
			const written = readFileSync(image_url);
			expect(Array.from(written)).toEqual([0xff, 0xd8, 0x10]);
			return "A red apple on a white background.";
		});

		const provider = createMinimaxImageUnderstanding({
			apiKey: "k",
			apiHost: "https://api.minimax.io",
			toolClientFactory: async () => fake.client,
		});

		const result = await provider.understand({
			prompt: "what is this?",
			bytes: new Uint8Array([0xff, 0xd8, 0x10]),
			extension: "jpg",
		});

		expect(result.text).toBe("A red apple on a white background.");
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].prompt).toBe("what is this?");
		expect(fake.calls[0].image_url.endsWith(".jpg")).toBe(true);
		// Temp dir cleaned up after the call.
		expect(existsSync(fake.calls[0].image_url)).toBe(false);

		await provider.close();
		expect(fake.closed()).toBe(true);
	});

	test("normalizes MCP content-array responses to plain text", async () => {
		const fake = createFakeClient(() => [
			{ type: "text", text: "Line one." },
			{ type: "text", text: "Line two." },
			{ type: "image", data: "ignored" },
		]);

		const provider = createMinimaxImageUnderstanding({
			apiKey: "k",
			apiHost: "h",
			toolClientFactory: async () => fake.client,
		});

		const result = await provider.understand({
			prompt: "describe",
			bytes: new Uint8Array([1]),
			extension: "png",
		});

		expect(result.text).toBe("Line one.\nLine two.");
		await provider.close();
	});

	test("starts the MCP client lazily and reuses it across calls", async () => {
		let factoryCalls = 0;
		const fake = createFakeClient(() => "ok");
		const provider = createMinimaxImageUnderstanding({
			apiKey: "k",
			apiHost: "h",
			toolClientFactory: async () => {
				factoryCalls += 1;
				return fake.client;
			},
		});

		expect(factoryCalls).toBe(0);
		await provider.understand({
			prompt: "a",
			bytes: new Uint8Array([1]),
			extension: "jpg",
		});
		await provider.understand({
			prompt: "b",
			bytes: new Uint8Array([2]),
			extension: "jpg",
		});
		expect(factoryCalls).toBe(1);
		await provider.close();
	});

	test("propagates factory errors and allows retry on next call", async () => {
		let attempt = 0;
		const fake = createFakeClient(() => "after-recovery");
		const provider = createMinimaxImageUnderstanding({
			apiKey: "k",
			apiHost: "h",
			toolClientFactory: async () => {
				attempt += 1;
				if (attempt === 1) throw new Error("boom");
				return fake.client;
			},
		});

		await expect(
			provider.understand({
				prompt: "a",
				bytes: new Uint8Array([1]),
				extension: "jpg",
			}),
		).rejects.toThrow(/boom/);

		const second = await provider.understand({
			prompt: "b",
			bytes: new Uint8Array([2]),
			extension: "jpg",
		});
		expect(second.text).toBe("after-recovery");
		expect(attempt).toBe(2);
		await provider.close();
	});
});
