import * as os from "node:os";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import type { AppConfig } from "../config";
import { createDb, detectDialect } from "../db/index";
import { readThreadMessages } from "../memory/rotate_thread";
import { CLIApprovalBroker } from "../permissions/approval";
import { maybeHandleCommand } from "../permissions/commands";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import type {
	OutboundChannel,
	OutboundSendFileArgs,
	OutboundSendResult,
} from "./outbound";
import { maybeHandleSessionCommand } from "./session_commands";
import {
	buildInvokeMessages,
	clearPendingCompactionSeed,
	clearPendingTaskCheckContext,
	createChannelAgentSession,
	extractAgentReply,
	maybeRunPendingTaskCheck,
	prepareSessionForIncomingTurn,
} from "./shared";
import type { AppChannel, ChannelRunOptions } from "./types";
import { createStatusEmitter } from "../tools/status_emitter";
import { extractLocaleFromCli, resolveLocale } from "../i18n/locale";

const CLI_DEFAULT_POLICY = process.env.CLI_DEFAULT_POLICY ?? "permissive";

export class CliOutboundChannel implements OutboundChannel {
	constructor(
		private readonly stream: NodeJS.WritableStream = process.stdout,
	) {}

	async sendFile(args: OutboundSendFileArgs): Promise<OutboundSendResult> {
		const header = `\n--- attached: ${args.path} (${args.bytes.length} bytes, ${args.mimeType}) ---\n`;
		this.stream.write(header);
		this.stream.write(Buffer.from(args.bytes));
		if (args.bytes.length > 0) {
			const last = args.bytes[args.bytes.length - 1];
			if (last !== 0x0a) {
				this.stream.write("\n");
			}
		}
		if (args.caption) {
			this.stream.write(`--- caption: ${args.caption}\n`);
		}
		this.stream.write("--- end ---\n");
		return { ok: true };
	}

	async sendStatus(_callerId: string, message: string): Promise<void> {
		try {
			this.stream.write(`[status] ${message}\n`);
		} catch {
		}
	}
}

export function resolveCliCaller(): Caller {
	const username = os.userInfo().username || "local";
	return {
		id: `cli:${username}`,
		entrypoint: "cli",
		externalId: username,
		displayName: username,
	};
}

export async function seedCliUser(
	store: PermissionsStore,
	caller: Caller,
): Promise<void> {
	const existing = await store.getUser(caller.entrypoint, caller.externalId);
	if (existing) return;
	await store.upsertUser({
		entrypoint: caller.entrypoint,
		externalId: caller.externalId,
		displayName: caller.displayName ?? null,
	});
	if (CLI_DEFAULT_POLICY === "strict") {
		await store.upsertRule(caller.id, {
			priority: 1000,
			toolName: "*",
			args: null,
			decision: "ask",
		});
	}
}

export const cliChannel: AppChannel = {
	entrypoint: "cli",
	async run(config: AppConfig, options?: ChannelRunOptions): Promise<void> {
		const webShare = options?.webShare;
		const db = options?.db ?? createDb(config.databaseUrl);
		const dialect = options?.dialect ?? detectDialect(config.databaseUrl);
		const store = new PermissionsStore({ db, dialect });
		const caller = resolveCliCaller();
		await seedCliUser(store, caller);

		const broker = new CLIApprovalBroker(store);
		const outbound = new CliOutboundChannel();
		const statusEmitter = createStatusEmitter(outbound);
		const localeHint = extractLocaleFromCli();
		const locale = resolveLocale(localeHint, config.defaultStatusLocale as "en" | "ru" | "es");
		const baseThreadId = `cli-${caller.id}`;
		const session = await createChannelAgentSession(config, {
			db,
			dialect,
			caller,
			store,
			broker,
			threadId: baseThreadId,
			outbound,
			webShare,
			statusEmitter,
			locale,
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
				compaction: session.compactionConfig
					? {
							caller: session.compactionConfig.caller,
							store: session.compactionConfig.store,
						}
					: undefined,
				webShare: webShare
					? {
							access: webShare.access,
							publicBaseUrl: webShare.publicBaseUrl,
							callerId: caller.id,
						}
					: undefined,
			});
			if (sessionCommand.handled) {
				console.log(sessionCommand.reply);
				console.log();
				continue;
			}

			const command = await maybeHandleCommand(userInput, caller, store);
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
				session.currentUserText = userInput;
				await session.refreshAgent();
				const currentMessages = await readThreadMessages(
					session.agent,
					session.threadId,
				);
				const preparedTurn = await prepareSessionForIncomingTurn(
					session,
					currentMessages,
					userInput,
					mintThreadId,
				);
				const taskCheck = await maybeRunPendingTaskCheck(session, userInput);
				if (taskCheck.handled) {
					clearInterval(spinner);
					process.stdout.write("\rAssistant: ");
					console.log(`${taskCheck.reply ?? ""}\n`);
					continue;
				}
				if (preparedTurn.compacted || taskCheck.needsRefresh) {
					await session.refreshAgent();
				}
				const invokeMessages = buildInvokeMessages(session, {
					role: "user",
					content: userInput,
				});
				const result = await session.agent.invoke(
					{ messages: invokeMessages },
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
			} finally {
				clearPendingCompactionSeed(session);
				clearPendingTaskCheckContext(session);
				session.currentUserText = undefined;
			}
		}

		rl.close();
		if (!options?.db) {
			await db.close();
		}
	},
};
