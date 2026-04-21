import { afterEach, describe, expect, test, vi } from "bun:test";
import { PassThrough } from "node:stream";
import type { Bot } from "grammy";
import { CliOutboundChannel } from "./cli";
import { TelegramOutboundChannel } from "./telegram";

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
		test("sends message to resolved chatId", async () => {
			const sentMessages: Array<{ chatId: string; text: string }> = [];
			const mockBot = {
				api: {
					sendMessage: vi.fn().mockImplementation(async (chatId: string, text: string) => {
						sentMessages.push({ chatId, text });
					}),
				},
			} as unknown as Bot;

			const channel = new TelegramOutboundChannel(
				mockBot,
				(callerId) => (callerId === "telegram:123" ? "123" : null),
			);

			await channel.sendStatus("telegram:123", "Running workspace script");

			expect(sentMessages).toEqual([{ chatId: "123", text: "Running workspace script" }]);
		});

		test("does nothing when callerId cannot be resolved", async () => {
			const mockBot = {
				api: {
					sendMessage: vi.fn(),
				},
			} as unknown as Bot;

			const channel = new TelegramOutboundChannel(
				mockBot,
				() => null,
			);

			await channel.sendStatus("telegram:unknown", "Reading a.md");

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
			);

			await expect(
				channel.sendStatus("telegram:123", "Reading a.md"),
			).resolves.toBeUndefined();
		});
	});
});