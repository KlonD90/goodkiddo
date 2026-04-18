import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalizePath } from "../backends/sqlite_state_backend";

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

type GrantRow = {
	link_uuid: string;
	bearer_token: string;
	user_id: string;
	scope_path: string;
	scope_kind: string;
	expires_at: number;
	created_at: number;
	revoked_at: number | null;
};

function generateBearerToken(): string {
	return randomBytes(32).toString("base64url");
}

function rowToGrant(row: GrantRow): AccessGrant {
	return {
		linkUuid: row.link_uuid,
		userId: row.user_id,
		scopePath: row.scope_path,
		scopeKind: row.scope_kind as ScopeKind,
		expiresAt: row.expires_at,
	};
}

function rowToResolvedGrant(row: GrantRow): ResolvedGrant {
	return {
		...rowToGrant(row),
		bearerToken: row.bearer_token,
	};
}

export interface AccessStoreOptions {
	dbPath: string;
	now?: () => number;
}

export class AccessStore {
	private readonly database: Database;
	private readonly now: () => number;

	constructor(options: AccessStoreOptions) {
		if (options.dbPath !== ":memory:") {
			mkdirSync(dirname(options.dbPath), { recursive: true });
		}
		this.database = new Database(options.dbPath);
		this.database.exec("PRAGMA journal_mode = WAL");
		this.database.exec("PRAGMA foreign_keys = ON");
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS fs_access_grants (
				link_uuid TEXT PRIMARY KEY,
				bearer_token TEXT NOT NULL UNIQUE,
				user_id TEXT NOT NULL,
				scope_path TEXT NOT NULL,
				scope_kind TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				revoked_at INTEGER
			)
		`);
		this.database.exec(
			"CREATE INDEX IF NOT EXISTS idx_fs_access_grants_user ON fs_access_grants(user_id)",
		);
		this.now = options.now ?? (() => Date.now());
	}

	issue(userId: string, options: IssueOptions = {}): IssuedGrant {
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

		this.database
			.query(
				`INSERT INTO fs_access_grants
					(link_uuid, bearer_token, user_id, scope_path, scope_kind, expires_at, created_at, revoked_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)`,
			)
			.run(
				linkUuid,
				bearerToken,
				userId,
				scopePath,
				scopeKind,
				expiresAt,
				createdAt,
			);

		return { linkUuid, userId, scopePath, scopeKind, expiresAt, bearerToken };
	}

	resolveLink(linkUuid: string): ResolvedGrant | null {
		const row = this.database
			.query<GrantRow, [string, number]>(
				`SELECT * FROM fs_access_grants
				 WHERE link_uuid = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
			)
			.get(linkUuid, this.now());
		return row ? rowToResolvedGrant(row) : null;
	}

	resolveBearer(bearerToken: string): ResolvedGrant | null {
		if (bearerToken === "") return null;
		const row = this.database
			.query<GrantRow, [string, number]>(
				`SELECT * FROM fs_access_grants
				 WHERE bearer_token = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
			)
			.get(bearerToken, this.now());
		return row ? rowToResolvedGrant(row) : null;
	}

	revokeByLink(linkUuid: string): void {
		this.database
			.query(
				"UPDATE fs_access_grants SET revoked_at = ?2 WHERE link_uuid = ?1 AND revoked_at IS NULL",
			)
			.run(linkUuid, this.now());
	}

	revokeByUser(userId: string): number {
		const result = this.database
			.query(
				"UPDATE fs_access_grants SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL",
			)
			.run(userId, this.now());
		return Number(result.changes);
	}

	listActive(userId: string): AccessGrant[] {
		const rows = this.database
			.query<GrantRow, [string, number]>(
				`SELECT * FROM fs_access_grants
				 WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2
				 ORDER BY created_at DESC`,
			)
			.all(userId, this.now());
		return rows.map(rowToGrant);
	}

	sweepExpired(): number {
		const result = this.database
			.query("DELETE FROM fs_access_grants WHERE expires_at <= ?1")
			.run(this.now());
		return Number(result.changes);
	}

	close(): void {
		this.database.close();
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
