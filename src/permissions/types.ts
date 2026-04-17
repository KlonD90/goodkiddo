import { z } from "zod";

export const PermissionDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const ArgumentOperatorSchema = z.union([
	z.strictObject({ eq: z.unknown() }),
	z.strictObject({ in: z.array(z.unknown()) }),
	z.strictObject({ glob: z.string() }),
	z.strictObject({ regex: z.string() }),
]);
export type ArgumentOperator = z.infer<typeof ArgumentOperatorSchema>;

export const ArgumentMatcherSchema = z.record(
	z.string(),
	ArgumentOperatorSchema,
);
export type ArgumentMatcher = z.infer<typeof ArgumentMatcherSchema>;

export const ToolRuleSchema = z.object({
	id: z.number().int().nonnegative(),
	userId: z.string(),
	priority: z.number().int(),
	toolName: z.string(),
	args: ArgumentMatcherSchema.nullable(),
	decision: PermissionDecisionSchema,
});
export type ToolRule = z.infer<typeof ToolRuleSchema>;

export const NewToolRuleSchema = ToolRuleSchema.omit({
	id: true,
	userId: true,
});
export type NewToolRule = z.infer<typeof NewToolRuleSchema>;

export const UserStatusSchema = z.enum(["active", "suspended"]);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const EntrypointSchema = z.enum(["cli", "telegram"]);
export type Entrypoint = z.infer<typeof EntrypointSchema>;

export const UserRecordSchema = z.object({
	id: z.string(),
	entrypoint: EntrypointSchema,
	externalId: z.string(),
	displayName: z.string().nullable(),
	status: UserStatusSchema,
	createdAt: z.number().int(),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

export type Caller = {
	id: string;
	entrypoint: Entrypoint;
	externalId: string;
	displayName?: string;
};

export function callerId(entrypoint: Entrypoint, externalId: string): string {
	return `${entrypoint}:${externalId}`;
}

export type ResolvedDecision = {
	decision: PermissionDecision;
	ruleId: number | "default-allow" | "default-ask";
};
