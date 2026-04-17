import * as os from "node:os";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import type { AppConfig } from "../config";
import { CLIApprovalBroker } from "../permissions/approval";
import { maybeHandleCommand } from "../permissions/commands";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import { createChannelAgentSession, extractAgentReply } from "./shared";
import { maybeHandleSessionCommand } from "./session_commands";
import type { AppChannel } from "./types";

const CLI_DEFAULT_POLICY = process.env.CLI_DEFAULT_POLICY ?? "permissive";

export function resolveCliCaller(): Caller {
	const username = os.userInfo().username || "local";
	return {
		id: `cli:${username}`,
		entrypoint: "cli",
		externalId: username,
		displayName: username,
	};
}

export function seedCliUser(store: PermissionsStore, caller: Caller): void {
	const existing = store.getUser(caller.entrypoint, caller.externalId);
	if (existing) return;
	store.upsertUser({
		entrypoint: caller.entrypoint,
		externalId: caller.externalId,
		displayName: caller.displayName ?? null,
	});
	if (CLI_DEFAULT_POLICY === "strict") {
		store.upsertRule(caller.id, {
			priority: 1000,
			toolName: "*",
			args: null,
			decision: "ask",
		});
	}
}

export const cliChannel: AppChannel = {
	entrypoint: "cli",
	async run(config: AppConfig): Promise<void> {
		const store = new PermissionsStore({ dbPath: config.stateDbPath });
		const caller = resolveCliCaller();
		seedCliUser(store, caller);

		const broker = new CLIApprovalBroker(store);
		const baseThreadId = `cli-${caller.id}`;
		const session = await createChannelAgentSession(config, {
			caller,
			store,
			broker,
			threadId: baseThreadId,
		});

		const mintThreadId = () => `${baseThreadId}-${Date.now()}`;

		const rl = readline.createInterface({ input, output });


		console.log(
			`Chat started as ${caller.id}. Type "exit" to quit, "/help" for permission commands, "/new-thread" to start a fresh conversation.\n`,
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

			const sessionCommand = await maybeHandleSessionCommand(userInput, {
				session,
				model: session.model,
				backend: session.workspace,
				mintThreadId,
			});
			if (sessionCommand.handled) {
				console.log(sessionCommand.reply);
				console.log();
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
			const spinner = setInterval(() => {
				process.stdout.write(
					`\r${spinnerFrames[spinnerIdx++ % spinnerFrames.length]} Thinking...`,
				);
			}, 80);

			try {
				await session.refreshAgent();
				const result = await session.agent.invoke(
					{ messages: [{ role: "user", content: userInput }] },
					{ configurable: { thread_id: session.threadId } },
				);
				const reply = extractAgentReply(result);

				clearInterval(spinner);
				process.stdout.write("\rAssistant: ");
				console.log(`${reply}\n`);
			} catch (error) {
				clearInterval(spinner);
				const message =
					error instanceof Error ? error.message : "Unknown CLI error";
				process.stdout.write("\rAssistant: ");
				console.log(`Request failed: ${message}\n`);
			}
		}

		rl.close();
	},
};
