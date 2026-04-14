import { createAgent } from "langchain";
import { SqliteStateBackend } from "./backends";
import type { AppConfig } from "./config";
import DO_IT_MD from "./identities/DO_IT.md?raw";
import { modelChooser } from "./model/model_chooser";
import type { ApprovalBroker } from "./permissions/approval";
import type { AuditLogger } from "./permissions/audit";
import type { PermissionsStore } from "./permissions/store";
import type { Caller } from "./permissions/types";
import { createExecutionToolset } from "./tools";
import type { GuardContext } from "./tools/guard";

export interface CreateAppAgentOptions {
	caller: Caller;
	store: PermissionsStore;
	broker: ApprovalBroker;
	audit: AuditLogger;
}

export const createAppAgent = async (
	config: AppConfig,
	options: CreateAppAgentOptions,
) => {
	const model = modelChooser(
		config.aiType,
		config.aiModelName,
		config.aiApiKey,
		config.aiBaseUrl,
	);

	const workspace = new SqliteStateBackend({
		dbPath: config.stateDbPath,
		namespace: options.caller.id,
	});

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
	});

	return createAgent({
		model,
		tools,
		systemPrompt: DO_IT_MD,
	});
};
