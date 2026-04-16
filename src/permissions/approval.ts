import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import type { PermissionsStore } from "./store";
import type { ArgumentMatcher, Caller } from "./types";

export type ApprovalOutcome =
	| "approve-once"
	| "approve-always"
	| "deny-once"
	| "deny-always";

export type ApprovalRequest = {
	caller: Caller;
	toolName: string;
	args: unknown;
};

export interface ApprovalBroker {
	requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
}

type CliQuestion = (prompt: string) => Promise<string>;

function summarizeArgs(args: unknown): string {
	try {
		const json = JSON.stringify(args);
		if (json.length <= 180) return json;
		return `${json.slice(0, 177)}...`;
	} catch {
		return String(args);
	}
}

export function deriveArgMatcherForAlways(
	args: unknown,
): ArgumentMatcher | null {
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return null;
	}
	const matcher: ArgumentMatcher = {};
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			matcher[key] = { eq: value };
		}
	}
	return Object.keys(matcher).length > 0 ? matcher : null;
}

export async function persistAlwaysRule(
	store: PermissionsStore,
	caller: Caller,
	toolName: string,
	args: unknown,
	decision: "allow" | "deny",
): Promise<void> {
	const matcher = deriveArgMatcherForAlways(args);
	store.upsertRule(caller.id, {
		priority: 100,
		toolName,
		args: matcher,
		decision,
	});
}

export class CLIApprovalBroker implements ApprovalBroker {
	constructor(
		private readonly store: PermissionsStore,
		private readonly ask: CliQuestion = createCliQuestion(),
	) {}

	async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
		process.stdout.write("\n");
		process.stdout.write(
			`Tool approval requested: ${request.toolName}(${summarizeArgs(request.args)})\n`,
		);
		process.stdout.write(
			"[y] allow once   [a] always allow   [n] deny once   [d] always deny\n",
		);
		while (true) {
			const answer = (await this.ask("> ")).trim().toLowerCase();
			if (answer === "y" || answer === "yes") return "approve-once";
			if (answer === "a" || answer === "always") {
				await persistAlwaysRule(
					this.store,
					request.caller,
					request.toolName,
					request.args,
					"allow",
				);
				return "approve-always";
			}
			if (answer === "n" || answer === "no" || answer === "") {
				return "deny-once";
			}
			if (answer === "d" || answer === "never") {
				await persistAlwaysRule(
					this.store,
					request.caller,
					request.toolName,
					request.args,
					"deny",
				);
				return "deny-always";
			}
			process.stdout.write("Please answer y / a / n / d.\n");
		}
	}
}

function createCliQuestion(): CliQuestion {
	return async (prompt: string) => {
		const rl = readline.createInterface({ input, output });
		try {
			return await rl.question(prompt);
		} finally {
			rl.close();
		}
	};
}

export function outcomeApproves(outcome: ApprovalOutcome): boolean {
	return outcome === "approve-once" || outcome === "approve-always";
}
