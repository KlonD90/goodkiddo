import { randomBytes, randomUUID } from "node:crypto";
import { normalizePath } from "../backends/state_backend";
import type { AppPrisma } from "../db/prisma";

export type ScopeKind = "root" | "dir" | "file";

export const MAX_TTL_MS = 24 * 60 * 60 * 1000;

export interface AccessGrant {
	linkUuid: string;
	userId: string;
	scopePath: string;
	scopeKind: ScopeKind;
	expiresAt: number;
}

export interface IssuedGrant extends AccessGrant {
	bearerToken: string;
}

export interface ResolvedGrant extends AccessGrant {
	bearerToken: string;
}

export interface IssueOptions {
	ttlMs?: number;
	scopePath?: string;
	scopeKind?: ScopeKind;
}

type GrantModel = {
	linkUuid: string;
	bearerToken: string;
	userId: string;
	scopePath: string;
	scopeKind: string;
	expiresAt: bigint | number;
	createdAt: bigint | number;
	revokedAt: bigint | number | null;
};

function generateBearerToken(): string {
	return randomBytes(32).toString("base64url");
}

function rowToGrant(row: GrantModel): AccessGrant {
	return {
		linkUuid: row.linkUuid,
		userId: row.userId,
		scopePath: row.scopePath,
		scopeKind: row.scopeKind as ScopeKind,
		expiresAt: Number(row.expiresAt),
	};
}

function rowToResolvedGrant(row: GrantModel): ResolvedGrant {
	return {
		...rowToGrant(row),
		bearerToken: row.bearerToken,
	};
}

export interface AccessStoreOptions {
	prisma: AppPrisma;
	now?: () => number;
}

export class AccessStore {
	private readonly prisma: AppPrisma;
	private readonly now: () => number;

	constructor(options: AccessStoreOptions) {
		this.prisma = options.prisma;
		this.now = options.now ?? (() => Date.now());
	}

	async issue(
		userId: string,
		options: IssueOptions = {},
	): Promise<IssuedGrant> {
		const ttlMs = Math.min(options.ttlMs ?? MAX_TTL_MS, MAX_TTL_MS);
		if (ttlMs <= 0) {
			throw new Error("ttlMs must be positive");
		}
		const rawScopePath = options.scopePath ?? "/";
		const scopeKind: ScopeKind =
			options.scopeKind ?? (rawScopePath === "/" ? "root" : "dir");
		const scopePath =
			scopeKind === "file"
				? normalizePath(rawScopePath, "file")
				: normalizePath(rawScopePath, "dir");

		const linkUuid = randomUUID();
		const bearerToken = generateBearerToken();
		const createdAt = this.now();
		const expiresAt = createdAt + ttlMs;

		await this.prisma.fsAccessGrant.create({
			data: {
				linkUuid,
				bearerToken,
				userId,
				scopePath,
				scopeKind,
				expiresAt: BigInt(expiresAt),
				createdAt: BigInt(createdAt),
				revokedAt: null,
			},
		});

		return { linkUuid, userId, scopePath, scopeKind, expiresAt, bearerToken };
	}

	async resolveLink(linkUuid: string): Promise<ResolvedGrant | null> {
		const now = this.now();
		const row = await this.prisma.fsAccessGrant.findFirst({
			where: {
				linkUuid,
				revokedAt: null,
				expiresAt: { gt: BigInt(now) },
			},
		});
		return row ? rowToResolvedGrant(row) : null;
	}

	async resolveBearer(bearerToken: string): Promise<ResolvedGrant | null> {
		if (bearerToken === "") return null;
		const now = this.now();
		const row = await this.prisma.fsAccessGrant.findFirst({
			where: {
				bearerToken,
				revokedAt: null,
				expiresAt: { gt: BigInt(now) },
			},
		});
		return row ? rowToResolvedGrant(row) : null;
	}

	async revokeByLink(linkUuid: string): Promise<void> {
		const now = this.now();
		await this.prisma.fsAccessGrant.updateMany({
			where: { linkUuid, revokedAt: null },
			data: { revokedAt: BigInt(now) },
		});
	}

	async revokeByUser(userId: string): Promise<number> {
		const now = this.now();
		const result = await this.prisma.fsAccessGrant.updateMany({
			where: { userId, revokedAt: null },
			data: { revokedAt: BigInt(now) },
		});
		return result.count;
	}

	async listActive(userId: string): Promise<AccessGrant[]> {
		const now = this.now();
		const rows = await this.prisma.fsAccessGrant.findMany({
			where: {
				userId,
				revokedAt: null,
				expiresAt: { gt: BigInt(now) },
			},
			orderBy: { createdAt: "desc" },
		});
		return rows.map(rowToGrant);
	}

	async sweepExpired(): Promise<number> {
		const now = this.now();
		const result = await this.prisma.fsAccessGrant.deleteMany({
			where: { expiresAt: { lte: BigInt(now) } },
		});
		return result.count;
	}

	close(): void {
		// No-op: lifecycle is managed by the injected db connection
	}
}

export function withinScope(
	requestedPath: string,
	scopePath: string,
	scopeKind: ScopeKind,
): boolean {
	if (scopeKind === "root") return true;
	if (scopeKind === "file") return requestedPath === scopePath;
	if (requestedPath === scopePath) return true;
	if (requestedPath === scopePath.replace(/\/$/, "")) return true;
	return requestedPath.startsWith(scopePath);
}
