import { createAgent } from "langchain";
import { SqliteStateBackend } from "./backends";
import type { AppConfig } from "./config";
import DO_IT_MD from "./identities/DO_IT.md?raw";
import { modelChooser } from "./model/model_chooser";
import { createExecutionToolset } from "./tools";

export const createAppAgent = async (config: AppConfig) => {
  const model = modelChooser(
    config.aiType,
    config.aiModelName,
    config.aiApiKey,
    config.aiBaseUrl,
  );

  const workspace = new SqliteStateBackend({
    dbPath: "./state.db",
    namespace: "user1",
  });

  const tools = await createExecutionToolset({
    workspace,
    backend: {
      backend: "auto",
      docker: {
        image: "top-fedder-dev:latest",
        allowUnsafeNetwork: true,
      },
    },
  });

  return createAgent({
    model,
    tools,
    systemPrompt: DO_IT_MD,
  });
};
