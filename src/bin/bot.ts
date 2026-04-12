import { createAgent } from "langchain";
import { SqliteStateBackend } from "../backends";
import DO_IT_MD from "../identities/DO_IT.md?raw";
import { createExecutionToolset } from "../tools";
import { modelChooser } from "../model/model_chooser";
import { AI_API_KEY, AI_MODEL_NAME, AI_BASE_URL, AI_TYPE } from "../config";

console.log("Main MD:", DO_IT_MD);

console.log("AI_TYPE:", AI_TYPE);
console.log("AI_MODEL_NAME:", AI_MODEL_NAME);
console.log("AI_API_KEY:", AI_API_KEY);
console.log("AI_BASE_URL:", AI_BASE_URL);

const model = modelChooser(AI_TYPE, AI_MODEL_NAME, AI_API_KEY, AI_BASE_URL);

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

const agent = createAgent({
  model: model,
  tools,
  systemPrompt: DO_IT_MD,
});

const stream = agent.streamEvents({
  messages: [
    {
      role: "user",
      content:
        "Write little script with bun that will take file host.txt with google.com and ya.ru (file with list of hosts) and fetch each host and return http status code for each host. Execute it please then and tell me how result.",
    },
  ],
});

let counter = 0;
for await (const message of stream) {
  console.log(message);
  counter++;
  if (counter > 300) {
    break;
  }
}
