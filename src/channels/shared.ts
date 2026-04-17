import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import { type AppAgentBundle, createAppAgent } from "../app";
import { createPersistentCheckpointer } from "../checkpoints/bun_sqlite_saver";
import type { AppConfig } from "../config";
import type { ApprovalBroker } from "../permissions/approval";
import { FileAuditLogger } from "../permissions/audit";
import type { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";

export type AgentInstance = AppAgentBundle["agent"];

export type ChannelAgentSession = {
	agent: AgentInstance;
	threadId: string;
	workspace: BackendProtocol;
	model: BaseChatModel;
	refreshAgent: () => Promise<void>;
};

export async function createChannelAgentSession(
	config: AppConfig,
	options: {
		caller: Caller;
		store: PermissionsStore;
		broker: ApprovalBroker;
		threadId: string;
	},
): Promise<ChannelAgentSession> {
	const audit = new FileAuditLogger("./permissions.log");
	const checkpointer = createPersistentCheckpointer(config.stateDbPath);
	const makeBundle = () =>
		createAppAgent(config, {
			caller: options.caller,
			store: options.store,
			broker: options.broker,
			audit,
			checkpointer,
		});
	let bundle = await makeBundle();

	const session: ChannelAgentSession = {
		agent: bundle.agent,
		threadId: options.threadId,
		workspace: bundle.workspace,
		model: bundle.model,
		refreshAgent: async () => {
			bundle = await makeBundle();
			session.agent = bundle.agent;
			session.workspace = bundle.workspace;
			session.model = bundle.model;
		},
	};

	return session;
}

export const extractTextFromContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => extractTextFromContent(item))
			.filter((item) => item !== "")
			.join("\n");
	}
	if (typeof content === "object" && content !== null) {
		if ("text" in content && typeof content.text === "string") {
			return content.text;
		}
		if ("content" in content) {
			return extractTextFromContent(content.content);
		}
	}
	return "";
};

function isAssistantMessage(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;

	if ("role" in message) {
		const role = message.role;
		if (role === "assistant" || role === "ai") return true;
	}

	if ("getType" in message && typeof message.getType === "function") {
		const type = message.getType();
		if (type === "ai" || type === "assistant") return true;
	}

	return false;
}

export const extractAgentReply = (result: { messages?: unknown[] }): string => {
	const messages = result.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isAssistantMessage(message)) continue;
		const content =
			typeof message === "object" && message !== null
				? extractTextFromContent(message.content)
				: "";
		if (content !== "") return content;
	}
	return "The agent completed the task but did not return a text response.";
};
