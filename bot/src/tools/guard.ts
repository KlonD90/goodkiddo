import { tool } from "langchain";
import type { SupportedLocale } from "../i18n/locale.js";
import { createLogger } from "../logger";
import type { Caller } from "../permissions/types";
import type { StatusEmitter } from "./status_emitter";
import { renderStatus } from "./status_templates";

const log = createLogger("tools.guard");

export type GuardContext = {
	caller: Caller;
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
			log.debug("tool call started", {
				toolName: original.name,
				callerId: context.caller.id,
			});
			await emitStatus(
				context.statusEmitter,
				context.caller.id,
				original.name,
				input,
				context.locale,
			);
			log.debug("tool call executing", {
				toolName: original.name,
				callerId: context.caller.id,
			});
			return await original.invoke(input);
		} catch (error) {
			log.debug("tool call failed", {
				toolName: original.name,
				callerId: context.caller.id,
				error: error instanceof Error ? error.message : String(error),
			});
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
