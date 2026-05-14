import type { AppPrisma } from "../db/prisma";
import {
	type Caller,
	callerId,
	type Entrypoint,
	type UserRecord,
	type UserStatus,
	type UserTier,
} from "./types";

export interface PermissionsStoreOptions {
	prisma: AppPrisma;
}

type PrismaUser = {
	id: string;
	entrypoint: string;
	externalId: string;
	displayName: string | null;
	tier: string;
	status: string;
	createdAt: bigint | number;
	identityId: string | null;
};

function prismaUserToRecord(user: PrismaUser): UserRecord {
	return {
		id: user.id,
		entrypoint: user.entrypoint as Entrypoint,
		externalId: user.externalId,
		displayName: user.displayName ?? null,
		tier: user.tier as UserTier,
		status: user.status as UserStatus,
		createdAt: Number(user.createdAt),
		identityId: user.identityId ?? null,
	};
}

export class PermissionsStore {
	private readonly prisma: AppPrisma;

	constructor(options: PermissionsStoreOptions) {
		this.prisma = options.prisma;
	}

	async getUser(
		entrypoint: Entrypoint,
		externalId: string,
	): Promise<UserRecord | null> {
		const user = await this.prisma.harnessUser.findUnique({
			where: { entrypoint_externalId: { entrypoint, externalId } },
		});
		return user ? prismaUserToRecord(user) : null;
	}

	async getUserById(userId: string): Promise<UserRecord | null> {
		const user = await this.prisma.harnessUser.findUnique({
			where: { id: userId },
		});
		return user ? prismaUserToRecord(user) : null;
	}

	async listUsers(): Promise<UserRecord[]> {
		const users = await this.prisma.harnessUser.findMany({
			orderBy: { createdAt: "asc" },
		});
		return users.map(prismaUserToRecord);
	}

	async upsertUser(params: {
		entrypoint: Entrypoint;
		externalId: string;
		displayName?: string | null;
	}): Promise<UserRecord> {
		const id = callerId(params.entrypoint, params.externalId);
		const now = Date.now();
		const displayName = params.displayName ?? null;
		const existing = await this.prisma.harnessUser.findUnique({
			where: { id },
		});
		const user = existing
			? await this.prisma.harnessUser.update({
					where: { id },
					data:
						displayName === null
							? {}
							: {
									displayName,
								},
				})
			: await this.prisma.harnessUser.create({
					data: {
						id,
						entrypoint: params.entrypoint,
						externalId: params.externalId,
						displayName,
						tier: "paid",
						status: "active",
						createdAt: BigInt(now),
						identityId: null,
					},
				});
		return prismaUserToRecord(user);
	}

	async createUserFree(params: {
		entrypoint: Entrypoint;
		externalId: string;
		displayName?: string | null;
	}): Promise<UserRecord> {
		const id = callerId(params.entrypoint, params.externalId);
		const now = Date.now();
		const displayName = params.displayName ?? null;
		const existing = await this.prisma.harnessUser.findUnique({
			where: { id },
		});
		if (existing) {
			return prismaUserToRecord(existing);
		}
		const user = await this.prisma.harnessUser.create({
			data: {
				id,
				entrypoint: params.entrypoint,
				externalId: params.externalId,
				displayName,
				tier: "free",
				status: "active",
				createdAt: BigInt(now),
				identityId: null,
			},
		});
		return prismaUserToRecord(user);
	}

	async upgradeToPaid(userId: string): Promise<UserRecord> {
		const user = await this.prisma.harnessUser.update({
			where: { id: userId },
			data: { tier: "paid" },
		});
		return prismaUserToRecord(user);
	}

	async upsertUserPaid(params: {
		entrypoint: Entrypoint;
		externalId: string;
		displayName?: string | null;
	}): Promise<UserRecord> {
		const id = callerId(params.entrypoint, params.externalId);
		const now = Date.now();
		const displayName = params.displayName ?? null;
		const existing = await this.prisma.harnessUser.findUnique({
			where: {
				entrypoint_externalId: {
					entrypoint: params.entrypoint,
					externalId: params.externalId,
				},
			},
		});
		if (existing) {
			const user = await this.prisma.harnessUser.update({
				where: { id: existing.id },
				data: {
					...(displayName === null ? {} : { displayName }),
					tier: "paid",
					status: "active",
				},
			});
			return prismaUserToRecord(user);
		}
		const user = await this.prisma.harnessUser.create({
			data: {
				id,
				entrypoint: params.entrypoint,
				externalId: params.externalId,
				displayName,
				tier: "paid",
				status: "active",
				createdAt: BigInt(now),
				identityId: null,
			},
		});
		return prismaUserToRecord(user);
	}

	async setUserStatus(userId: string, status: UserStatus): Promise<void> {
		await this.prisma.harnessUser.update({
			where: { id: userId },
			data: { status },
		});
	}

	async ensureUser(caller: Caller): Promise<UserRecord> {
		const existing = await this.getUser(caller.entrypoint, caller.externalId);
		if (existing) return existing;
		return this.createUserFree({
			entrypoint: caller.entrypoint,
			externalId: caller.externalId,
			displayName: caller.displayName ?? null,
		});
	}

	async setUserIdentity(userId: string, identityId: string): Promise<void> {
		await this.prisma.harnessUser.update({
			where: { id: userId },
			data: { identityId },
		});
	}

	async clearUserIdentity(userId: string): Promise<void> {
		await this.prisma.harnessUser.update({
			where: { id: userId },
			data: { identityId: null },
		});
	}

	close(): void {
		// No-op: lifecycle is managed by the injected Prisma client.
	}
}
