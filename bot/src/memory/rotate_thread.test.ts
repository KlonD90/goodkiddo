import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SqliteStateBackend } from "../backends";
import type { ChannelAgentSession } from "../channels/shared";
import { createDb, detectDialect } from "../db";
import { readOrEmpty } from "./fs";
import { MEMORY_LOG_PATH } from "./layout";
import { readThreadMessages, rotateThread } from "./rotate_thread";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

function createStubModel(response: string) {
	const seen: Array<{ role: string; content: string }> = [];
	const model = {
		async invoke(messages: Array<{ role: string; content: string }>) {
			for (const message of messages) seen.push(message);
			return { content: response };
		},
	} as unknown as BaseChatModel;
	return { model, seen };
}

describe("rotateThread", () => {
	test("summarizes array-based chat messages from thread state", async () => {
		const backend = createBackend("rotate-array-content");
		const { model, seen } = createStubModel("- captured");
		const session = {
			threadId: "telegram-123",
			agent: {
				async getState() {
					return {
						values: {
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: "Kenshiro has black hair." }],
								},
								{
									role: "assistant",
									content: [
										{ type: "text", text: "Understood, I mixed them up." },
									],
								},
								{
									role: "tool",
									content: [
										{
											type: "tool_result",
											content: "Search result text",
										},
									],
								},
							],
						},
					};
				},
			},
			workspace: backend,
			model,
			refreshAgent: async () => undefined,
		} as unknown as ChannelAgentSession;

		const result = await rotateThread({
			session,
			model,
			backend,
			mintThreadId: () => "telegram-123-next",
		});

		expect(result.summary).toBe("- captured");
		expect(result.previousThreadId).toBe("telegram-123");
		expect(result.newThreadId).toBe("telegram-123-next");
		expect(session.threadId).toBe("telegram-123-next");
		expect(seen[1]?.content).toContain(
			'<turn role="user">Kenshiro has black hair.</turn>',
		);
		expect(seen[1]?.content).toContain(
			'<turn role="assistant">Understood, I mixed them up.</turn>',
		);
		expect(seen[1]?.content).toContain(
			'<turn role="tool">Search result text</turn>',
		);

		const log = await readOrEmpty(backend, MEMORY_LOG_PATH);
		expect(log).toContain("thread_closed");
		expect(log).toContain("- captured");
	});

	test("ignores synthetic checkpoint system messages when summarizing a rotated thread", async () => {
		const backend = createBackend("rotate-ignores-checkpoint-system");
		const { model, seen } = createStubModel("- summarized");
		const session = {
			threadId: "thread-with-checkpoint",
			agent: {
				async getState() {
					return {
						values: {
							messages: [
								{
									role: "system",
									content:
										"[Conversation Checkpoint]\nGoal: Continue previous work",
								},
								{ role: "user", content: "Continue with the fix" },
								{ role: "assistant", content: "Working on it." },
							],
						},
					};
				},
			},
			workspace: backend,
			model,
			refreshAgent: async () => undefined,
		} as unknown as ChannelAgentSession;

		await rotateThread({
			session,
			model,
			backend,
			mintThreadId: () => "thread-next",
		});

		expect(seen[1]?.content).toContain(
			'<turn role="user">Continue with the fix</turn>',
		);
		expect(seen[1]?.content).toContain(
			'<turn role="assistant">Working on it.</turn>',
		);
		expect(seen[1]?.content).not.toContain("[Conversation Checkpoint]");
	});

	test("ignores synthetic current-message metadata when reading thread history", async () => {
		const agent = {
			async getState() {
				return {
					values: {
						messages: [
							{
								role: "user",
								content:
									"[Current message metadata]\n- Current message time in UTC: 2026-04-25T00:00:00.000Z\n- Time source: Telegram message timestamp\n- For duration-only one-time reminders, compute the UTC target instant.\n[/Current message metadata]",
							},
							{ role: "user", content: "hi" },
							{ role: "assistant", content: "hello" },
						],
					},
				};
			},
		};

		const messages = await readThreadMessages(agent as never, "thread-meta");

		expect(messages).toEqual([
			{ role: "user", content: "hi", estimatedTokens: 1 },
			{ role: "assistant", content: "hello", estimatedTokens: 2 },
		]);
	});

	test("does not summarize synthetic current-message metadata when rotating", async () => {
		const backend = createBackend("rotate-ignores-current-metadata");
		const { model, seen } = createStubModel("- summarized");
		const session = {
			threadId: "thread-with-metadata",
			agent: {
				async getState() {
					return {
						values: {
							messages: [
								{
									role: "user",
									content:
										"[Current message metadata]\n- Current message time in UTC: 2026-04-25T00:00:00.000Z\n- Time source: Telegram message timestamp\n- For duration-only one-time reminders, compute the UTC target instant.\n[/Current message metadata]",
								},
								{ role: "user", content: "Continue with the fix" },
								{ role: "assistant", content: "Working on it." },
							],
						},
					};
				},
			},
			workspace: backend,
			model,
			refreshAgent: async () => undefined,
		} as unknown as ChannelAgentSession;

		await rotateThread({
			session,
			model,
			backend,
			mintThreadId: () => "thread-next",
		});

		expect(seen[1]?.content).toContain(
			'<turn role="user">Continue with the fix</turn>',
		);
		expect(seen[1]?.content).not.toContain("[Current message metadata]");
	});

	test("propagates thread-state read failures instead of treating them as empty history", async () => {
		const backend = createBackend("rotate-read-failure");
		const { model } = createStubModel("- should not be used");
		const agent = {
			async getState() {
				throw new Error("db unavailable");
			},
		};

		await expect(
			readThreadMessages(agent as never, "broken-thread"),
		).rejects.toThrow(
			"Failed to read thread messages for broken-thread: db unavailable",
		);

		const session = {
			threadId: "broken-thread",
			agent,
			workspace: backend,
			model,
			refreshAgent: async () => undefined,
		} as unknown as ChannelAgentSession;

		await expect(
			rotateThread({
				session,
				model,
				backend,
				mintThreadId: () => "next-thread",
			}),
		).rejects.toThrow(
			"Failed to read thread messages for broken-thread: db unavailable",
		);
		expect(session.threadId).toBe("broken-thread");

		const log = await readOrEmpty(backend, MEMORY_LOG_PATH);
		expect(log).not.toContain("thread_closed");
	});

	test("keeps the current thread active when persisting the rotated thread id fails", async () => {
		const backend = createBackend("rotate-persist-failure");
		const { model } = createStubModel("- summarized");
		const session = {
			threadId: "thread-before",
			agent: {
				async getState() {
					return {
						values: {
							messages: [{ role: "user", content: "Continue with the fix" }],
						},
					};
				},
			},
			workspace: backend,
			model,
			refreshAgent: async () => undefined,
			persistThreadId: async () => {
				throw new Error("persist failed");
			},
		} as unknown as ChannelAgentSession;

		await expect(
			rotateThread({
				session,
				model,
				backend,
				mintThreadId: () => "thread-after",
			}),
		).rejects.toThrow(
			"Failed to persist thread ID change from thread-before to thread-after",
		);
		expect(session.threadId).toBe("thread-before");
	});
});
