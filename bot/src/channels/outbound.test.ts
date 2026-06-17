import { describe, expect, test, vi } from "bun:test";
import { PassThrough } from "node:stream";
import type { Bot } from "grammy";
import { CliOutboundChannel } from "./cli";
import { TelegramOutboundChannel } from "./telegram";

const wait = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

describe("OutboundChannel sendStatus", () => {
	describe("CliOutboundChannel", () => {
		test("writes prefixed status line to stream", async () => {
			const stream = new PassThrough();
			const chunks: string[] = [];
			stream.on("data", (chunk) => chunks.push(chunk.toString()));

			const channel = new CliOutboundChannel(stream);
			await channel.sendStatus("cli:tester", "Reading a.md");

			expect(chunks).toEqual(["[status] Reading a.md\n"]);
		});

		test("sendStatus never throws on stream error", async () => {
			const stream = new PassThrough();
			const channel = new CliOutboundChannel(stream);
			stream.destroy();

			await expect(
				channel.sendStatus("cli:tester", "Reading a.md"),
			).resolves.toBeUndefined();
		});

		test("callerId is accepted but not used in CLI output", async () => {
			const stream = new PassThrough();
			const chunks: string[] = [];
			stream.on("data", (chunk) => chunks.push(chunk.toString()));

			const channel = new CliOutboundChannel(stream);
			await channel.sendStatus("cli:someone-else", "Searching for X");

			expect(chunks).toEqual(["[status] Searching for X\n"]);
		});
	});

	describe("TelegramOutboundChannel", () => {
		function createMockBot() {
			const sentMessages: Array<{ chatId: string; text: string }> = [];
			const mockBot = {
				api: {
					sendMessage: vi
						.fn()
						.mockImplementation(async (chatId: string, text: string) => {
							sentMessages.push({ chatId, text });
						}),
				},
			} as unknown as Bot;
			return { mockBot, sentMessages };
		}

		test("sends message to resolved chatId after debounce window", async () => {
			const { mockBot, sentMessages } = createMockBot();

			const channel = new TelegramOutboundChannel(
				mockBot,
				(callerId) => (callerId === "telegram:123" ? "123" : null),
				5,
			);

			await channel.sendStatus("telegram:123", "Running workspace script");
			expect(sentMessages).toEqual([]);

			await wait(10);

			expect(sentMessages).toEqual([
				{ chatId: "123", text: "Running workspace script" },
			]);
		});

		test("collapses rapid calls into the most recent message", async () => {
			const { mockBot, sentMessages } = createMockBot();

			const channel = new TelegramOutboundChannel(
				mockBot,
				(callerId) => (callerId === "telegram:123" ? "123" : null),
				50,
			);

			await channel.sendStatus("telegram:123", "first");
			await channel.sendStatus("telegram:123", "second");
			await channel.sendStatus("telegram:123", "third");

			await wait(10);
			expect(sentMessages).toEqual([]);

			await wait(60);

			expect(sentMessages).toEqual([{ chatId: "123", text: "third" }]);
		});

		test("tracks debounce state per callerId", async () => {
			const { mockBot, sentMessages } = createMockBot();

			const channel = new TelegramOutboundChannel(
				mockBot,
				(callerId) =>
					callerId.startsWith("telegram:") ? callerId.slice(9) : null,
				50,
			);

			await channel.sendStatus("telegram:1", "a");
			await channel.sendStatus("telegram:2", "b");

			await wait(60);

			expect(sentMessages).toEqual([
				{ chatId: "1", text: "a" },
				{ chatId: "2", text: "b" },
			]);
		});

		test("does nothing when callerId cannot be resolved", async () => {
			const mockBot = {
				api: {
					sendMessage: vi.fn(),
				},
			} as unknown as Bot;

			const channel = new TelegramOutboundChannel(mockBot, () => null, 5);

			await channel.sendStatus("telegram:unknown", "Reading a.md");
			await wait(10);

			expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
		});

		test("swallows errors from sendMessage", async () => {
			const mockBot = {
				api: {
					sendMessage: vi.fn().mockRejectedValue(new Error("network error")),
				},
			} as unknown as Bot;

			const channel = new TelegramOutboundChannel(
				mockBot,
				(callerId) => (callerId === "telegram:123" ? "123" : null),
				5,
			);

			await expect(
				channel.sendStatus("telegram:123", "Reading a.md"),
			).resolves.toBeUndefined();
			await wait(10);
			expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);
		});
	});
});
