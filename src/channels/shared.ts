import { MemorySaver } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocol } from "deepagents";
import { type AppAgentBundle, createAppAgent } from "../app";
import type { AppConfig } from "../config";
import { FileAuditLogger } from "../permissions/audit";
import type { ApprovalBroker } from "../permissions/approval";
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
	const checkpointer = new MemorySaver();
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
			.map((item) => {
				if (typeof item === "string") return item;
				if (
					typeof item === "object" &&
					item !== null &&
					"text" in item &&
					typeof item.text === "string"
				) {
					return item.text;
				}
				return "";
			})
			.filter((item) => item !== "")
			.join("\n");
	}
	return "";
};

export const extractAgentReply = (result: {
	messages?: Array<{ content?: unknown }>;
}): string => {
	const messages = result.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const content = extractTextFromContent(messages[index]?.content);
		if (content !== "") return content;
	}
	return "The agent completed the task but did not return a text response.";
};
