import { type BaseCheckpointSaver, MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { SqliteStateBackend } from "./backends";
import { createImageUnderstandingProvider } from "./capabilities/image/factory";
import type { ImageUnderstandingProvider } from "./capabilities/image/types";
import type { createTimerTools } from "./capabilities/timers/tools";
import type { OutboundChannel } from "./channels/outbound";
import type { AppConfig } from "./config";
import type { AppPrisma } from "./db/prisma";
import type { SupportedLocale } from "./i18n/locale";
import { resolveDefaultPreset } from "./identities/registry";
import { ensureMemoryBootstrapped } from "./memory/bootstrap";
import { buildSystemPrompt } from "./memory/session_loader";
import { modelChooser } from "./model/model_chooser";
import type { PermissionsStore } from "./permissions/store";
import type { Caller } from "./permissions/types";
import { TaskStore } from "./tasks/store";
import { createExecutionToolset } from "./tools";
import type { WebShareOptions } from "./tools/factory";
import type { GuardContext } from "./tools/guard";
import { wrapToolWithGuard } from "./tools/guard";
import type { MemoryMutationCallback } from "./tools/memory_tools";
import type { StatusEmitter } from "./tools/status_emitter";

type TimerTools = ReturnType<typeof createTimerTools>;

export interface CreateAppAgentOptions {
	caller: Caller;
	store: PermissionsStore;
	prisma: AppPrisma;
	threadId: string;
	currentUserText?: string;
	taskStore?: TaskStore;
	checkpointer?: BaseCheckpointSaver;
	outbound?: OutboundChannel;
	runtimeContextBlock?: string;
	webShare?: WebShareOptions;
	timerTools?: TimerTools;
	statusEmitter?: StatusEmitter;
	locale?: SupportedLocale;
	onMemoryMutation?: MemoryMutationCallback;
	imageUnderstandingProvider?: ImageUnderstandingProvider | null;
	/** Resolved identity prompt to use as the agent's system identity. Defaults to the registry default. */
	identityPrompt?: string;
	/** Maximum recursion depth for the main agent. Defaults to LangGraph's built-in limit. */
	recursionLimit?: number;
}

export type AppAgentBundle = {
	agent: Awaited<ReturnType<typeof createAgent>>;
	workspace: SqliteStateBackend;
	model: ReturnType<typeof modelChooser>;
};

export const createAppAgent = async (
	config: AppConfig,
	options: CreateAppAgentOptions,
): Promise<AppAgentBundle> => {
	const model = modelChooser(
		config.aiType,
		config.aiModelName,
		config.aiApiKey,
		config.aiBaseUrl,
		{ temperature: config.aiTemperature },
	);
	const subAgentModel = modelChooser(
		config.aiType,
		config.aiModelName,
		config.aiApiKey,
		config.aiBaseUrl,
		{ temperature: config.aiSubAgentTemperature },
	);

	const workspace = new SqliteStateBackend({
		prisma: options.prisma,
		namespace: options.caller.id,
	});

	await ensureMemoryBootstrapped(workspace);
	const taskStore =
		options.taskStore ??
		new TaskStore({
			prisma: options.prisma,
		});
	const activeTaskSnapshot = await taskStore.composeActiveTaskSnapshot(
		options.caller.id,
	);

	const guard: GuardContext = {
		caller: options.caller,
		statusEmitter: options.statusEmitter,
		locale: options.locale,
	};

	const imageUnderstandingProvider =
		options.imageUnderstandingProvider !== undefined
			? options.imageUnderstandingProvider
			: createImageUnderstandingProvider(config);

	const executionTools = await createExecutionToolset({
		workspace,
		backend: {
			backend: "auto",
			docker: {
				image: "top-fedder-dev:latest",
				allowUnsafeNetwork: true,
			},
		},
		guard,
		enableExecute: config.enableExecute,
		callerId: options.caller.id,
		threadId: options.threadId,
		currentUserText: options.currentUserText,
		taskStore,
		outbound: options.outbound,
		webShare: options.webShare,
		statusEmitter: options.statusEmitter,
		locale: options.locale,
		onMemoryMutation: options.onMemoryMutation,
		imageUnderstandingProvider,
		model: subAgentModel,
	});

	const guardedTimerTools = options.timerTools
		? options.timerTools.map((t) => wrapToolWithGuard(t, guard))
		: [];
	const tools = [...executionTools, ...guardedTimerTools];

	const systemPrompt = await buildSystemPrompt({
		identityPrompt: options.identityPrompt ?? resolveDefaultPreset().prompt,
		backend: workspace,
		activeTaskSnapshot,
		runtimeContextBlock: options.runtimeContextBlock,
	});

	const agent = createAgent({
		model,
		tools,
		systemPrompt,
		checkpointer: options.checkpointer ?? new MemorySaver(),
	});

	return { agent, workspace, model };
};
