import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SqliteStateBackend } from "../backends";
import type { ChannelAgentSession } from "../channels/shared";
import { readOrEmpty } from "./fs";
import { MEMORY_LOG_PATH } from "./layout";
import { rotateThread } from "./rotate_thread";

function createBackend(namespace: string) {
	return new SqliteStateBackend({ dbPath: ":memory:", namespace });
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
});
