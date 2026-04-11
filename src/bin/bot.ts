import { ChatAnthropic } from "@langchain/anthropic";
import { createFilesystemMiddleware } from "deepagents";
import { createAgent } from "langchain";
import { SqliteStateBackend } from "../backends";
import MAIN_MD from "../identities/DO_IT.md";
import { createExecutionToolset } from "../tools";

console.log("Main MD:", MAIN_MD);

const model = new ChatAnthropic({
  modelName: "google/gemma-4-26b-a4b",
  anthropicApiUrl: "http://localhost:1234",
});

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
      allowUnsafeNetwork: false,
    },
  },
});

const agent = createAgent({
  model: model,
  tools,
  systemPrompt: MAIN_MD,
  middleware: [
    createFilesystemMiddleware({
      backend: workspace,
    }),
  ],
});

const stream = agent.streamEvents({
  messages: [
    {
      role: "user",
      content:
        "Write a Python script called hello.py that prints 'Hello from the execution tool', execute it, and tell me the exit code.",
    },
  ],
});

let counter = 0;
for await (const message of stream) {
  console.log(message);
  counter++;
  if (counter > 100) {
    break;
  }
}
