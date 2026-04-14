import { matchesArguments } from "./matcher";
import type { ResolvedDecision, ToolRule } from "./types";

export function resolveDecision(
	rules: ToolRule[],
	toolName: string,
	args: unknown,
): ResolvedDecision {
	const sorted = [...rules].sort((a, b) => a.priority - b.priority);
	for (const rule of sorted) {
		if (rule.toolName !== "*" && rule.toolName !== toolName) continue;
		if (!matchesArguments(rule.args, args)) continue;
		return { decision: rule.decision, ruleId: rule.id };
	}
	return { decision: "ask", ruleId: "default-ask" };
}
