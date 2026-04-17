import type { PermissionsStore } from "./store";
import type { ArgumentMatcher, Caller, ToolRule } from "./types";
import { ArgumentMatcherSchema } from "./types";

export type CommandResult =
	| { handled: false }
	| { handled: true; reply: string };

function parseSlashCommand(input: string): { command: string; rest: string } | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return null;

	const firstSpace = trimmed.indexOf(" ");
	const rawCommand = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace))
		.slice(1)
		.toLowerCase();
	const command = rawCommand.split("@", 1)[0] ?? "";
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);

	return command === "" ? null : { command, rest };
}

type ParsedArgs = {
	positional: string[];
	flags: Record<string, string>;
};

function parseArgs(input: string): ParsedArgs {
	const tokens = tokenize(input);
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token.startsWith("--")) {
			const name = token.slice(2);
			const next = tokens[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[name] = next;
				i += 1;
				continue;
			}
			flags[name] = "true";
			continue;
		}
		positional.push(token);
	}
	return { positional, flags };
}

function tokenize(input: string): string[] {
	return input.split(/\s+/).filter((token) => token.length > 0);
}

function parseMatcherFlag(value: string | undefined): ArgumentMatcher | null {
	if (!value) return null;
	const json = JSON.parse(value) as unknown;
	return ArgumentMatcherSchema.parse(json);
}

function formatRules(rules: ToolRule[]): string {
	if (rules.length === 0)
		return "No policy rules. Most tools are allowed automatically; execute tools still ask for approval.";
	const lines = rules.map((rule) => {
		const args = rule.args ? ` args=${JSON.stringify(rule.args)}` : "";
		return `  [${rule.priority}] ${rule.decision.padEnd(5)} ${rule.toolName}${args}`;
	});
	return `Policy rules (first match wins; default is allow except execute tools ask):\n${lines.join("\n")}`;
}

export function maybeHandleCommand(
	input: string,
	caller: Caller,
	store: PermissionsStore,
): CommandResult {
	const parsedCommand = parseSlashCommand(input);
	if (!parsedCommand) return { handled: false };
	const { command, rest } = parsedCommand;

	if (command === "policy") {
		const rules = store.listRulesForUser(caller.id);
		return { handled: true, reply: formatRules(rules) };
	}

	if (command === "reset") {
		const removed = store.deleteAllRulesForUser(caller.id);
		return {
			handled: true,
			reply: `Removed ${removed} rule(s). Tools now follow the default policy: allow except execute tools ask.`,
		};
	}

	if (command === "allow" || command === "deny" || command === "ask") {
		const parsed = parseArgs(rest);
		const toolName = parsed.positional[0];
		if (!toolName) {
			return {
				handled: true,
				reply: `Usage: /${command} <tool> [--args <json>]`,
			};
		}

		let matcher: ArgumentMatcher | null;
		try {
			matcher = parseMatcherFlag(parsed.flags.args);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				handled: true,
				reply: `Failed to parse --args JSON: ${message}`,
			};
		}

		if (command === "ask") {
			const removed = store.deleteMatchingRules(caller.id, toolName, matcher);
			return {
				handled: true,
				reply: `Removed ${removed} matching rule(s). '${toolName}' now follows the default policy.`,
			};
		}

		const priority = parsed.flags.priority
			? Number(parsed.flags.priority)
			: 100;
		store.upsertRule(caller.id, {
			priority: Number.isFinite(priority) ? priority : 100,
			toolName,
			args: matcher,
			decision: command,
		});
		return {
			handled: true,
			reply: `Rule saved: ${command} ${toolName}${matcher ? ` (args=${JSON.stringify(matcher)})` : ""}.`,
		};
	}

	if (command === "help") {
		return {
			handled: true,
			reply: [
				"Permission commands:",
				"  /policy                          show your current rules",
				"  /allow <tool> [--args <json>]    always allow a tool",
				"  /deny  <tool> [--args <json>]    always deny a tool",
				"  /ask   <tool> [--args <json>]    forget a rule (revert to default policy)",
				"  /reset                           clear all your rules",
			].join("\n"),
		};
	}

	return { handled: false };
}
