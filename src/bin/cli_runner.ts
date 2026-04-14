import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createAppAgent } from "../app";
import type { AppConfig } from "../config";

export const runCliEntrypoint = async (config: AppConfig): Promise<void> => {
	const agent = await createAppAgent(config);
	const rl = readline.createInterface({ input, output });
	const threadId = `cli-${Date.now()}`;

	console.log('Chat started. Type "exit" or press Ctrl+C to quit.\n');

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

		const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		let spinnerIdx = 0;
		let firstToken = false;
		const spinner = setInterval(() => {
			process.stdout.write(`\r${spinnerFrames[spinnerIdx++ % spinnerFrames.length]} Thinking...`);
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
