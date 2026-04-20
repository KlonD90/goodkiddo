import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import type { ChannelAgentSession } from "../channels/shared";
import { readOrEmpty } from "./fs";
import { MEMORY_LOG_PATH } from "./layout";
import { rotateThread } from "./rotate_thread";

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
		expect(seen[1]?.content).toContain("USER: Kenshiro has black hair.");
		expect(seen[1]?.content).toContain(
			"ASSISTANT: Understood, I mixed them up.",
		);
		expect(seen[1]?.content).toContain("TOOL: Search result text");

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

		expect(seen[1]?.content).toContain("USER: Continue with the fix");
		expect(seen[1]?.content).toContain("ASSISTANT: Working on it.");
		expect(seen[1]?.content).not.toContain("[Conversation Checkpoint]");
	});
});
