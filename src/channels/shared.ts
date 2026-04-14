import { createAppAgent } from "../app";
import type { AppConfig } from "../config";
import { FileAuditLogger } from "../permissions/audit";
import type { ApprovalBroker } from "../permissions/approval";
import type { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";

export type AgentInstance = Awaited<ReturnType<typeof createAppAgent>>;

export type ChannelAgentSession = {
	agent: AgentInstance;
	threadId: string;
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
	const agent = await createAppAgent(config, {
		caller: options.caller,
		store: options.store,
		broker: options.broker,
		audit,
	});

	return {
		agent,
		threadId: options.threadId,
	};
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
