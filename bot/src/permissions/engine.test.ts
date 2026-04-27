import { describe, expect, test } from "bun:test";
import { resolveDecision } from "./engine";
import type { ToolRule } from "./types";

const baseRule = (overrides: Partial<ToolRule>): ToolRule => ({
	id: 1,
	userId: "u",
	priority: 100,
	toolName: "*",
	args: null,
	decision: "allow",
	...overrides,
});

describe("engine.resolveDecision", () => {
	test("non-execute tools default to allow when no rules", () => {
		expect(resolveDecision([], "anything", {})).toEqual({
			decision: "allow",
			ruleId: "default-allow",
		});
	});

	test("execute tools default to ask when no rules", () => {
		expect(resolveDecision([], "execute_workspace", {})).toEqual({
			decision: "ask",
			ruleId: "default-ask",
		});
	});

	test("first match wins by priority", () => {
		const rules: ToolRule[] = [
			baseRule({
				id: 1,
				priority: 50,
				toolName: "write_file",
				decision: "deny",
			}),
			baseRule({
				id: 2,
				priority: 10,
				toolName: "write_file",
				decision: "allow",
			}),
		];
		const resolved = resolveDecision(rules, "write_file", {});
		expect(resolved.decision).toBe("allow");
		expect(resolved.ruleId).toBe(2);
	});

	test("wildcard tool name matches", () => {
		const rules: ToolRule[] = [baseRule({ toolName: "*", decision: "allow" })];
		expect(resolveDecision(rules, "any_tool", {}).decision).toBe("allow");
	});

	test("argument matcher narrows the rule", () => {
		const rules: ToolRule[] = [
			baseRule({
				id: 1,
				priority: 10,
				toolName: "write_file",
				args: { file_path: { glob: "drafts/**" } },
				decision: "allow",
			}),
			baseRule({
				id: 2,
				priority: 100,
				toolName: "write_file",
				args: null,
				decision: "deny",
			}),
		];
		expect(
			resolveDecision(rules, "write_file", { file_path: "drafts/x.md" })
				.decision,
		).toBe("allow");
		expect(
			resolveDecision(rules, "write_file", { file_path: "secret.md" }).decision,
		).toBe("deny");
	});
});
