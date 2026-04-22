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
import type { PermissionsStore } from "./permissions/store";
import type { Caller } from "./permissions/types";
import { TaskStore } from "./tasks/store";
import { createExecutionToolset } from "./tools";
import type { WebShareOptions } from "./tools/factory";
import { wrapToolWithGuard } from "./tools/guard";
import type { GuardContext } from "./tools/guard";
import type { StatusEmitter } from "./tools/status_emitter";
import type { SupportedLocale } from "./i18n/locale";
import type { createTimerTools } from "./capabilities/timers/tools";

type TimerTools = ReturnType<typeof createTimerTools>;

export interface CreateAppAgentOptions {
  caller: Caller;
  store: PermissionsStore;
  broker: ApprovalBroker;
  db: SQL;
  dialect: "sqlite" | "postgres";
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
  const taskStore =
    options.taskStore ??
    new TaskStore({
      db: options.db,
      dialect: options.dialect,
    });
  const activeTaskSnapshot = await taskStore.composeActiveTaskSnapshot(
    options.caller.id,
  );

  const guard: GuardContext = {
    caller: options.caller,
    store: options.store,
    broker: options.broker,
    statusEmitter: options.statusEmitter,
    locale: options.locale,
  };

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
  });

  const guardedTimerTools = options.timerTools
    ? options.timerTools.map((t) => wrapToolWithGuard(t, guard))
    : [];
  const tools = [...executionTools, ...guardedTimerTools];

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
    middleware: [
      {
        name: "Debug",
        wrapModelCall: async (request, handler) => {
          console.log("request", request);
          console.log("state", request.state);
          console.log("messages", request.messages);
          for (const m of request.state.messages) {
            console.log("message len", m.content.length);
          }

          return await handler(request);
        },
      },
    ],
    checkpointer: options.checkpointer ?? new MemorySaver(),
  });

  return { agent, workspace, model };
};
