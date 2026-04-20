import { type BaseCheckpointSaver, MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { SqliteStateBackend } from "./backends";
import type { OutboundChannel } from "./channels/outbound";
import type { AppConfig } from "./config";
import DO_IT_MD from "./identities/DO_IT.md?raw";
import { ensureMemoryBootstrapped } from "./memory/bootstrap";
import { buildSystemPrompt } from "./memory/session_loader";
import { modelChooser } from "./model/model_chooser";
import type { ApprovalBroker } from "./permissions/approval";
import type { AuditLogger } from "./permissions/audit";
import type { PermissionsStore } from "./permissions/store";
import type { Caller } from "./permissions/types";
import { TaskStore } from "./tasks/store";
import { createExecutionToolset } from "./tools";
import type { WebShareOptions } from "./tools/factory";
import type { GuardContext } from "./tools/guard";

export interface CreateAppAgentOptions {
	caller: Caller;
	store: PermissionsStore;
	broker: ApprovalBroker;
	audit: AuditLogger;
	db: SQL;
	dialect: "sqlite" | "postgres";
	threadId: string;
	checkpointer?: BaseCheckpointSaver;
	outbound?: OutboundChannel;
	runtimeContextBlock?: string;
	webShare?: WebShareOptions;
}

// Memory-scoped agent bits that the channel layer also needs access to — the
// model (for /new-thread summarization) and the workspace backend (for log
// writes and direct reads). Returned alongside the agent.
type SQL = InstanceType<typeof Bun.SQL>;

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
	);

	const workspace = new SqliteStateBackend({
		db: options.db,
		dialect: options.dialect,
		namespace: options.caller.id,
	});

	await ensureMemoryBootstrapped(workspace);
	const taskStore = new TaskStore({
		db: options.db,
		dialect: options.dialect,
	});
	const activeTaskSnapshot = await taskStore.composeActiveTaskSnapshot(
		options.caller.id,
	);

	const guard: GuardContext | undefined =
		config.permissionsMode === "enforce"
			? {
					caller: options.caller,
					store: options.store,
					broker: options.broker,
					audit: options.audit,
				}
			: undefined;

	const tools = await createExecutionToolset({
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
		taskStore,
		outbound: options.outbound,
		webShare: options.webShare,
	});

	const systemPrompt = await buildSystemPrompt({
		identityPrompt: DO_IT_MD,
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
