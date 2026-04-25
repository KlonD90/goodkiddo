import { SearxngSearch } from "@langchain/community/tools/searxng_search";
import type { WorkspaceBackend } from "../backends/types";
import type { ImageUnderstandingProvider } from "../capabilities/image/types";
import type { OutboundChannel } from "../channels/outbound";
import type { ExecutionPolicy } from "../execution/manifest";
import { ExecutionOrchestrator } from "../execution/orchestrator";
import type { SupportedLocale } from "../i18n/locale.js";
import type { CreateSandboxBackendOptions } from "../sandbox/factory";
import { createSandboxBackend } from "../sandbox/factory";
import type { AccessStore } from "../server/access_store";
import type { TaskStore } from "../tasks/store";
import {
	createBrowserActionTool,
	createBrowserSnapshotTool,
	createSessionRegistry,
} from "./browser_tools";
import { createExecuteWorkspaceTool } from "./execute_tools";
import { createUnderstandImageTool } from "./image_understanding_tool";
import {
	createEditFileTool,
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadFileTool,
	createWriteFileTool,
} from "./filesystem_tools";
import { type GuardContext, wrapToolWithGuard } from "./guard";
import {
	createMemoryAppendLogTool,
	createMemoryWriteTool,
	createSkillWriteTool,
	type MemoryMutationCallback,
} from "./memory_tools";
import { createSendFileTool } from "./send_file_tool";
import { createGrantFsAccessTool } from "./share_tools";
import { createStatusEmitter, noopStatusEmitter } from "./status_emitter";
import {
	createTaskAddTool,
	createTaskCompleteTool,
	createTaskDismissTool,
	createTaskListActiveTool,
} from "./task_tools";

export interface WebShareOptions {
	access: AccessStore;
	publicBaseUrl: string;
}

export interface CreateExecutionToolsetOptions {
	workspace: WorkspaceBackend;
	backend?: CreateSandboxBackendOptions;
	policy?: ExecutionPolicy;
	guard?: GuardContext;
	enableExecute?: boolean;
	callerId?: string;
	threadId?: string;
	currentUserText?: string;
	taskStore?: TaskStore;
	outbound?: OutboundChannel;
	webShare?: WebShareOptions;
	statusEmitter?: ReturnType<typeof createStatusEmitter>;
	locale?: SupportedLocale;
	enableToolStatus?: boolean;
	onMemoryMutation?: MemoryMutationCallback;
	imageUnderstandingProvider?: ImageUnderstandingProvider | null;
}

const UNGUARDED_TOOL_NAMES = new Set<string>(["send_file", "grant_fs_access"]);

export async function createExecutionToolset(
	options: CreateExecutionToolsetOptions,
) {
	const enableExecute = options.enableExecute ?? true;

	let executeTool: ReturnType<typeof createExecuteWorkspaceTool> | null = null;
	if (enableExecute) {
		const sandboxBackend = await createSandboxBackend(options.backend);
		const orchestrator = new ExecutionOrchestrator({
			backend: sandboxBackend,
			policy: options.policy,
		});
		executeTool = createExecuteWorkspaceTool(orchestrator, options.workspace);
	}

	const browserRegistry = createSessionRegistry(options.callerId ?? "shared");

	const sendFileTool =
		options.outbound && options.callerId
			? createSendFileTool({
					workspace: options.workspace,
					outbound: options.outbound,
					callerId: options.callerId,
				})
			: null;

	const shareTool =
		options.webShare && options.callerId
			? createGrantFsAccessTool({
					access: options.webShare.access,
					workspace: options.workspace,
					callerId: options.callerId,
					publicBaseUrl: options.webShare.publicBaseUrl,
				})
			: null;

	const taskTools =
		options.taskStore && options.callerId && options.threadId
			? [
					createTaskAddTool({
						store: options.taskStore,
						callerId: options.callerId,
						threadId: options.threadId,
						currentUserText: options.currentUserText,
					}),
					createTaskCompleteTool({
						store: options.taskStore,
						callerId: options.callerId,
						threadId: options.threadId,
						currentUserText: options.currentUserText,
					}),
					createTaskDismissTool({
						store: options.taskStore,
						callerId: options.callerId,
						threadId: options.threadId,
						currentUserText: options.currentUserText,
					}),
					createTaskListActiveTool({
						store: options.taskStore,
						callerId: options.callerId,
						threadId: options.threadId,
						currentUserText: options.currentUserText,
					}),
				]
			: [];

	const tools = [
		createLsTool(options.workspace),
		createReadFileTool(options.workspace),
		createWriteFileTool(options.workspace),
		createEditFileTool(options.workspace),
		createGlobTool(options.workspace),
		createGrepTool(options.workspace),
		createMemoryWriteTool(options.workspace, options.onMemoryMutation),
		createSkillWriteTool(options.workspace, options.onMemoryMutation),
		createMemoryAppendLogTool(options.workspace),
		...taskTools,
		createBrowserSnapshotTool({ registry: browserRegistry }),
		createBrowserActionTool({ registry: browserRegistry }),
		new SearxngSearch({
			params: {
				format: "json", // Do not change this, format other than "json" is will throw error
				engines: "google",
			},
			// Custom Headers to support rapidAPI authentication Or any instance that requires custom headers
			headers: {},
		}),
		...(executeTool ? [executeTool] : []),
		...(sendFileTool ? [sendFileTool] : []),
		...(shareTool ? [shareTool] : []),
		...(options.imageUnderstandingProvider
			? [
					createUnderstandImageTool({
						provider: options.imageUnderstandingProvider,
						backend: options.workspace,
					}),
				]
			: []),
	];

	if (!options.guard) return tools;
	const enableToolStatus = options.enableToolStatus ?? true;
	const statusEmitter = enableToolStatus
		? (options.statusEmitter ??
			(options.outbound
				? createStatusEmitter(options.outbound)
				: noopStatusEmitter))
		: noopStatusEmitter;
	const effectiveLocale = options.locale ?? "en";
	const guard: GuardContext = {
		...options.guard,
		statusEmitter,
		locale: effectiveLocale,
	};
	return tools.map((original) => {
		if (UNGUARDED_TOOL_NAMES.has(original.name)) return original;
		return wrapToolWithGuard(original, guard);
	});
}
