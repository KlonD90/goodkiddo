import { tool } from "langchain";
import type { AuditLogger } from "../permissions/audit";
import {
	type ApprovalBroker,
	outcomeApproves,
} from "../permissions/approval";
import { resolveDecision } from "../permissions/engine";
import type { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";

export type GuardContext = {
	caller: Caller;
	store: PermissionsStore;
	broker: ApprovalBroker;
	audit: AuditLogger;
};

// biome-ignore lint/suspicious/noExplicitAny: LangChain tool typings are deeply generic; we treat tools structurally.
type ToolLike = any;

export function wrapToolWithGuard(
	original: ToolLike,
	context: GuardContext,
): ReturnType<typeof tool> {
	const handler = async (input: unknown): Promise<unknown> => {
		const rules = context.store.listRulesForUser(context.caller.id);
		const resolved = resolveDecision(rules, original.name, input);

		if (resolved.decision === "deny") {
			context.audit.record({
				userId: context.caller.id,
				toolName: original.name,
				args: input,
				decision: "deny",
				ruleId: resolved.ruleId,
				outcome: "denied-by-policy",
			});
			return `Permission denied by policy: ${original.name}`;
		}

		if (resolved.decision === "ask") {
			const outcome = await context.broker.requestApproval({
				caller: context.caller,
				toolName: original.name,
				args: input,
			});
			if (!outcomeApproves(outcome)) {
				context.audit.record({
					userId: context.caller.id,
					toolName: original.name,
					args: input,
					decision: "deny",
					ruleId: resolved.ruleId,
					outcome: "denied-by-user",
				});
				return `Permission denied by user: ${original.name}`;
			}
			context.audit.record({
				userId: context.caller.id,
				toolName: original.name,
				args: input,
				decision: "allow",
				ruleId: resolved.ruleId,
				outcome: "allowed",
			});
			return await original.invoke(input);
		}

		context.audit.record({
			userId: context.caller.id,
			toolName: original.name,
			args: input,
			decision: "allow",
			ruleId: resolved.ruleId,
			outcome: "allowed",
		});
		return await original.invoke(input);
	};

	return tool(handler, {
		name: original.name,
		description: original.description ?? "",
		// biome-ignore lint/suspicious/noExplicitAny: schema type is opaque
		schema: original.schema as any,
	});
}
