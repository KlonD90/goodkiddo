import { z } from "zod";

export const UserTierSchema = z.enum(["free", "paid"]);
export type UserTier = z.infer<typeof UserTierSchema>;

export const UserStatusSchema = z.enum(["active", "suspended"]);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const EntrypointSchema = z.enum(["cli", "telegram"]);
export type Entrypoint = z.infer<typeof EntrypointSchema>;

export const UserRecordSchema = z.object({
	id: z.string(),
	entrypoint: EntrypointSchema,
	externalId: z.string(),
	displayName: z.string().nullable(),
	tier: UserTierSchema,
	status: UserStatusSchema,
	createdAt: z.number().int(),
	identityId: z.string().nullable().optional(),
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
