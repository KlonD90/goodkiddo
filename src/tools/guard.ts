import { tool } from "langchain";
import type { SupportedLocale } from "../i18n/locale.js";
import { createLogger } from "../logger";
import { type ApprovalBroker, outcomeApproves } from "../permissions/approval";
import { resolveDecision } from "../permissions/engine";
import type { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import type { StatusEmitter } from "./status_emitter";
import { renderStatus } from "./status_templates";

const log = createLogger("tools.guard");

export type GuardContext = {
	caller: Caller;
	store: PermissionsStore;
	broker: ApprovalBroker;
	statusEmitter?: StatusEmitter;
	locale?: SupportedLocale;
};

// biome-ignore lint/suspicious/noExplicitAny: LangChain tool typings are deeply generic; we treat tools structurally.
type ToolLike = any;

async function emitStatus(
	emitter: StatusEmitter | undefined,
	callerId: string,
	toolName: string,
	args: unknown,
	locale: SupportedLocale | undefined,
): Promise<void> {
	if (!emitter || !locale) return;
	try {
		const result = renderStatus(
			toolName,
			args as Record<string, unknown>,
			locale,
		);
		if (result) {
			await emitter.emit(callerId, result.message);
		}
	} catch (err) {
		log.error("renderStatus failed", {
			toolName,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export function wrapToolWithGuard(
		original: ToolLike,
		context: GuardContext,
	): ReturnType<typeof tool> {
		const handler = async (input: unknown): Promise<unknown> => {
			try {
				log.debug("tool call started", { toolName: original.name, callerId: context.caller.id });
				const rules = await context.store.listRulesForUser(context.caller.id);
				const resolved = resolveDecision(rules, original.name, input);

				if (resolved.decision === "deny") {
					log.debug("tool call denied by policy", { toolName: original.name, callerId: context.caller.id, ruleId: resolved.ruleId });
					// context.audit.record({
					//   userId: context.caller.id,
					//   toolName: original.name,
					//   args: input,
					//   decision: "deny",
					//   ruleId: resolved.ruleId,
					//   outcome: "denied-by-policy",
					// });
					return `Permission denied by policy: ${original.name}`;
				}

				if (resolved.decision === "ask") {
					log.debug("tool call awaiting approval", { toolName: original.name, callerId: context.caller.id, ruleId: resolved.ruleId });
					const outcome = await context.broker.requestApproval({
						caller: context.caller,
						toolName: original.name,
						args: input,
					});
					if (!outcomeApproves(outcome)) {
						log.debug("tool call denied by user", { toolName: original.name, callerId: context.caller.id, outcome });
						// context.audit.record({
						//   userId: context.caller.id,
						//   toolName: original.name,
						//   args: input,
						//   decision: "deny",
						//   ruleId: resolved.ruleId,
						//   outcome: "denied-by-user",
						// });
						return `Permission denied by user: ${original.name}`;
					}
					log.debug("tool call approved by user", { toolName: original.name, callerId: context.caller.id, outcome });
					// context.audit.record({
					//   userId: context.caller.id,
					//   toolName: original.name,
					//   args: input,
					//   decision: "allow",
					//   ruleId: resolved.ruleId,
					//   outcome: "allowed",
					// });
					await emitStatus(
						context.statusEmitter,
						context.caller.id,
						original.name,
						input,
						context.locale,
					);
					log.debug("tool call executing", { toolName: original.name, callerId: context.caller.id });
					return await original.invoke(input);
				}

				// context.audit.record({
				//   userId: context.caller.id,
				//   toolName: original.name,
				//   args: input,
				//   decision: "allow",
				//   ruleId: resolved.ruleId,
				//   outcome: "allowed",
				// });
				log.debug("tool call auto-allowed", { toolName: original.name, callerId: context.caller.id, ruleId: resolved.ruleId });
				await emitStatus(
					context.statusEmitter,
					context.caller.id,
					original.name,
					input,
					context.locale,
				);
				log.debug("tool call executing", { toolName: original.name, callerId: context.caller.id });
				return await original.invoke(input);
			} catch (error) {
				log.debug("tool call failed", { toolName: original.name, callerId: context.caller.id, error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		};

	return tool(handler, {
		name: original.name,
		description: original.description ?? "",
		// biome-ignore lint/suspicious/noExplicitAny: schema type is opaque
		schema: original.schema as any,
	});
}
