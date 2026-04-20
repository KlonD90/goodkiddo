import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// `/new-thread` wants a short summary of the closing conversation so the agent
// has a handle on it after history is wiped. One LLM call, plain text out.

export type ThreadMessage = {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	estimatedTokens?: number;
};

const SUMMARY_SYSTEM = [
	"You summarize a conversation that's about to be archived.",
	"Write 3-6 short bullets capturing: (a) user's intent, (b) decisions made,",
	"(c) unfinished threads, (d) any durable facts worth remembering.",
	"Be terse. No preamble. No conclusion. Bullets only.",
].join(" ");

export function renderTranscript(messages: ThreadMessage[]): string {
	return messages
		.filter((msg) => msg.content.trim().length > 0)
		.map((msg) => `${msg.role.toUpperCase()}: ${msg.content.trim()}`)
		.join("\n\n");
}

export async function summarizeThread(
	model: BaseChatModel,
	messages: ThreadMessage[],
): Promise<string> {
	if (messages.length === 0) return "Thread closed with no exchanges.";
	const transcript = renderTranscript(messages);
	const response = await model.invoke([
		{ role: "system", content: SUMMARY_SYSTEM },
		{ role: "user", content: transcript },
	]);
	const content = response.content;
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "string"
					? part
					: typeof part === "object" && part !== null && "text" in part
						? String((part as { text: unknown }).text ?? "")
						: "",
			)
			.join("")
			.trim();
	}
	return String(content).trim();
}
