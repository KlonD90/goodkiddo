import * as os from "node:os";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { createAppAgent } from "../app";
import type { AppConfig } from "../config";
import { CLIApprovalBroker } from "../permissions/approval";
import { FileAuditLogger } from "../permissions/audit";
import { maybeHandleCommand } from "../permissions/commands";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";

const CLI_DEFAULT_POLICY = process.env.CLI_DEFAULT_POLICY ?? "permissive";

function resolveCliCaller(): Caller {
	const username = os.userInfo().username || "local";
	return {
		id: `cli:${username}`,
		entrypoint: "cli",
		externalId: username,
		displayName: username,
	};
}

function seedCliUser(store: PermissionsStore, caller: Caller): void {
	const existing = store.getUser(caller.entrypoint, caller.externalId);
	if (existing) return;
	store.upsertUser({
		entrypoint: caller.entrypoint,
		externalId: caller.externalId,
		displayName: caller.displayName ?? null,
	});
	if (CLI_DEFAULT_POLICY !== "strict") {
		store.upsertRule(caller.id, {
			priority: 1000,
			toolName: "*",
			args: null,
			decision: "allow",
		});
	}
}

export const runCliEntrypoint = async (config: AppConfig): Promise<void> => {
	const store = new PermissionsStore({ dbPath: config.stateDbPath });
	const caller = resolveCliCaller();
	seedCliUser(store, caller);

	const broker = new CLIApprovalBroker(store);
	const audit = new FileAuditLogger("./permissions.log");

	const agent = await createAppAgent(config, { caller, store, broker, audit });
	const rl = readline.createInterface({ input, output });
	const threadId = `cli-${Date.now()}`;

	console.log(
		`Chat started as ${caller.id}. Type "exit" to quit, "/help" for permission commands.\n`,
	);

	process.on("SIGINT", () => {
		console.log("\nBye!");
		rl.close();
		process.exit(0);
	});

	while (true) {
		const userInput = await rl.question("You: ");

		if (userInput.trim().toLowerCase() === "exit") {
			console.log("Bye!");
			break;
		}

		if (!userInput.trim()) {
			continue;
		}

		const command = maybeHandleCommand(userInput, caller, store);
		if (command.handled) {
			console.log(command.reply);
			console.log();
			continue;
		}

		const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		let spinnerIdx = 0;
		let firstToken = false;
		const spinner = setInterval(() => {
			process.stdout.write(
				`\r${spinnerFrames[spinnerIdx++ % spinnerFrames.length]} Thinking...`,
			);
		}, 80);

		const stream = await agent.stream(
			{ messages: [{ role: "user", content: userInput }] },
			{
				streamMode: "messages",
				configurable: { thread_id: threadId },
			},
		);

		for await (const [message] of stream as AsyncIterable<
			[{ content: string | { type: string; text?: string }[]; type?: string }]
		>) {
			const isAi = message.type === "ai";
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((c) => c.type === "text")
							.map((c) => c.text ?? "")
							.join("");
			if (isAi && text) {
				if (!firstToken) {
					clearInterval(spinner);
					process.stdout.write("\rAssistant: ");
					firstToken = true;
				}
				process.stdout.write(text);
			}
		}

		clearInterval(spinner);
		if (!firstToken) {
			process.stdout.write("\rAssistant: ");
		}
		console.log("\n");
	}

	rl.close();
};
