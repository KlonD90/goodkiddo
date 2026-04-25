import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { summarizeThread, type ThreadMessage } from "./summarize";

// Minimal stub: surface the list of messages it was asked to summarize so we
// can assert what the summarizer fed to the LLM.
function createStubModel(response: string | { type: string; text: string }[]) {
	const seen: Array<{ role: string; content: string }> = [];
	const model = {
		async invoke(messages: Array<{ role: string; content: string }>) {
			for (const m of messages) seen.push(m);
			return { content: response };
		},
	} as unknown as BaseChatModel;
	return { model, seen };
}

describe("summarizeThread", () => {
	test("returns short-circuit when no messages", async () => {
		const { model } = createStubModel("unused");
		const summary = await summarizeThread(model, []);
		expect(summary).toContain("no exchanges");
	});

	test("calls model with system + user prompt and returns trimmed string", async () => {
		const { model, seen } = createStubModel(
			"  - intent was X\n- decision was Y  ",
		);
		const messages: ThreadMessage[] = [
			{ role: "user", content: "Please fix the bug" },
			{ role: "assistant", content: "Sure, here's the fix" },
		];
		const summary = await summarizeThread(model, messages);
		expect(summary).toBe("- intent was X\n- decision was Y");
		expect(seen).toHaveLength(2);
		expect(seen[0]?.role).toBe("system");
		expect(seen[1]?.role).toBe("user");
		expect(seen[1]?.content).toContain("<transcript_to_summarize>");
		expect(seen[1]?.content).toContain(
			'<turn role="user">Please fix the bug</turn>',
		);
		expect(seen[1]?.content).toContain(
			'<turn role="assistant">Sure, here\'s the fix</turn>',
		);
		expect(seen[1]?.content).toContain("Do NOT respond");
	});

	test("handles array content shape from LLM response", async () => {
		const { model } = createStubModel([
			{ type: "text", text: "bullet one" },
			{ type: "text", text: " and bullet two" },
		]);
		const summary = await summarizeThread(model, [
			{ role: "user", content: "hi" },
		]);
		expect(summary).toBe("bullet one and bullet two");
	});

	test("skips empty-content messages in transcript", async () => {
		const { model, seen } = createStubModel("ok");
		await summarizeThread(model, [
			{ role: "user", content: "   " },
			{ role: "assistant", content: "real reply" },
		]);
		const userMessage = seen.find((m) => m.role === "user");
		expect(userMessage?.content).not.toContain('<turn role="user">');
		expect(userMessage?.content).toContain(
			'<turn role="assistant">real reply</turn>',
		);
	});
});
