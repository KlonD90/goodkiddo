import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import type { AgentInstance, ChannelAgentSession } from "../channels/shared";
import { appendLog } from "./log";
import { summarizeThread, type ThreadMessage } from "./summarize";

// Rotates the session to a fresh thread_id after summarizing the current one
// into memory. Memory persists across the rotation; short-term conversation
// history does not.
//
// The MemorySaver doesn't expose a thread-delete primitive — abandoning the
// old thread_id is sufficient for v1 (state is held in a Map keyed by
// thread_id, and we just stop referencing the old key).

type AgentWithState = {
	getState?: (config: {
		configurable: { thread_id: string };
	}) => Promise<{ values?: { messages?: unknown[] } }>;
};

const CHECKPOINT_SYSTEM_HEADER = "[Conversation Checkpoint]";

function isSyntheticCheckpointSystemMessage(
	role: ThreadMessage["role"],
	content: string,
): boolean {
	return (
		role === "system" &&
		content.trimStart().startsWith(CHECKPOINT_SYSTEM_HEADER)
	);
}

function toThreadMessage(raw: unknown): ThreadMessage | null {
	if (raw === null || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;

	// Shape 1: plain { role, content }, where content may be a string or a
	// structured array of blocks from multimodal/tool-enabled providers.
	if (typeof obj.role === "string" && "content" in obj) {
		if (["user", "assistant", "system", "tool"].includes(obj.role)) {
			const content = extractContentText(obj.content);
			if (content.trim().length === 0) return null;
			const role = obj.role as ThreadMessage["role"];
			if (isSyntheticCheckpointSystemMessage(role, content)) return null;
			return { role, content };
		}
	}

	// Shape 2: LangChain BaseMessage instance, exposes _getType() and content
	const getType =
		typeof obj._getType === "function"
			? (obj._getType as () => string)()
			: typeof obj.type === "string"
				? (obj.type as string)
				: null;

	if (getType === null) return null;

	const role =
		getType === "human"
			? "user"
			: getType === "ai"
				? "assistant"
				: getType === "system"
					? "system"
					: getType === "tool"
						? "tool"
						: null;

	if (role === null) return null;

	const content = extractContentText(obj.content);
	if (content.trim().length === 0) return null;
	if (isSyntheticCheckpointSystemMessage(role, content)) return null;
	return { role, content };
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((part) => extractContentText(part)).join("");
	}
	if (typeof content === "object" && content !== null) {
		if ("text" in content) {
			const text = (content as { text?: unknown }).text;
			if (typeof text === "string") return text;
		}
		if ("content" in content) {
			return extractContentText((content as { content?: unknown }).content);
		}
	}
	return "";
}

export async function readThreadMessages(
	agent: AgentInstance,
	threadId: string,
): Promise<ThreadMessage[]> {
	const stateful = agent as unknown as AgentWithState;
	if (!stateful.getState) {
		throw new Error("Agent does not support thread state retrieval.");
	}

	try {
		const state = await stateful.getState({
			configurable: { thread_id: threadId },
		});
		const raw: unknown[] = state.values?.messages ?? [];
		return raw
			.map((item) => toThreadMessage(item))
			.filter((msg): msg is ThreadMessage => msg !== null);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "unknown thread state error";
		throw new Error(`Failed to read thread messages for ${threadId}: ${message}`);
	}
}

export async function rotateThread(options: {
	session: ChannelAgentSession;
	model: BaseChatModel;
	backend: BackendProtocol;
	mintThreadId: () => string;
}): Promise<{
	summary: string;
	previousThreadId: string;
	newThreadId: string;
}> {
	const { session, model, backend, mintThreadId } = options;
	const previousThreadId = session.threadId;

	const messages = await readThreadMessages(session.agent, previousThreadId);
	const summary =
		messages.length === 0
			? "Thread closed with no recorded exchanges."
			: await summarizeThread(model, messages);

	await appendLog(backend, "thread_closed", summary);

	const newThreadId = mintThreadId();
	session.threadId = newThreadId;
	session.needsResumeCompaction = false;
	await session.persistThreadId?.(newThreadId);

	return { summary, previousThreadId, newThreadId };
}
