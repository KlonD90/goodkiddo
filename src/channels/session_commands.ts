import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import { rotateThread } from "../memory/rotate_thread";
import type { ChannelAgentSession } from "./shared";

// Channel-agnostic session-control commands — separate concern from permission
// commands in src/permissions/commands.ts. Only `/new-thread` today; add more
// session-shaping commands here as they come up.

export type SessionCommandResult =
	| { handled: false }
	| { handled: true; reply: string };

export type SessionCommandContext = {
	session: ChannelAgentSession;
	model: BaseChatModel;
	backend: BackendProtocol;
	mintThreadId: () => string;
};

export async function maybeHandleSessionCommand(
	input: string,
	context: SessionCommandContext,
): Promise<SessionCommandResult> {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return { handled: false };

	const firstSpace = trimmed.indexOf(" ");
	const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace))
		.slice(1)
		.toLowerCase();

	if (command === "new-thread" || command === "new_thread") {
		const { summary, newThreadId } = await rotateThread({
			session: context.session,
			model: context.model,
			backend: context.backend,
			mintThreadId: context.mintThreadId,
		});
		return {
			handled: true,
			reply: [
				`New thread started (${newThreadId}).`,
				"Previous thread summarized into /memory/log.md:",
				summary,
			].join("\n"),
		};
	}

	return { handled: false };
}
