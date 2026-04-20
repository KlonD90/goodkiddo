import { randomBytes, randomUUID } from "node:crypto";
import { normalizePath } from "../backends/state_backend";

type SQL = InstanceType<typeof Bun.SQL>;

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
	db: SQL;
	dialect: "sqlite" | "postgres";
	now?: () => number;
}

export class AccessStore {
	private readonly database: SQL;
	private readonly dialect: "sqlite" | "postgres";
	private readonly now: () => number;
	private readonly _ready: Promise<void>;

	constructor(options: AccessStoreOptions) {
		this.database = options.db;
		this.dialect = options.dialect;
		this.now = options.now ?? (() => Date.now());
		this._ready = this._init();
		this._ready.catch(() => {}); // prevent unhandledRejection; error surfaces when methods await this._ready
	}

	private async _init(): Promise<void> {
		const db = this.database;
		await db`
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
    `;
		await db`
      CREATE INDEX IF NOT EXISTS idx_fs_access_grants_user ON fs_access_grants(user_id)
    `;
		if (this.dialect === "sqlite") {
			await db`PRAGMA journal_mode = WAL`;
		}
	}

	async issue(userId: string, options: IssueOptions = {}): Promise<IssuedGrant> {
		await this._ready;
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

		const db = this.database;
		await db`
      INSERT INTO fs_access_grants
        (link_uuid, bearer_token, user_id, scope_path, scope_kind, expires_at, created_at, revoked_at)
      VALUES (${linkUuid}, ${bearerToken}, ${userId}, ${scopePath}, ${scopeKind}, ${expiresAt}, ${createdAt}, NULL)
    `;

		return { linkUuid, userId, scopePath, scopeKind, expiresAt, bearerToken };
	}

	async resolveLink(linkUuid: string): Promise<ResolvedGrant | null> {
		await this._ready;
		const db = this.database;
		const now = this.now();
		const rows = await db<GrantRow[]>`
      SELECT * FROM fs_access_grants
      WHERE link_uuid = ${linkUuid} AND revoked_at IS NULL AND expires_at > ${now}
    `;
		return rows[0] ? rowToResolvedGrant(rows[0]) : null;
	}

	async resolveBearer(bearerToken: string): Promise<ResolvedGrant | null> {
		if (bearerToken === "") return null;
		await this._ready;
		const db = this.database;
		const now = this.now();
		const rows = await db<GrantRow[]>`
      SELECT * FROM fs_access_grants
      WHERE bearer_token = ${bearerToken} AND revoked_at IS NULL AND expires_at > ${now}
    `;
		return rows[0] ? rowToResolvedGrant(rows[0]) : null;
	}

	async revokeByLink(linkUuid: string): Promise<void> {
		await this._ready;
		const db = this.database;
		const now = this.now();
		await db`
      UPDATE fs_access_grants SET revoked_at = ${now}
      WHERE link_uuid = ${linkUuid} AND revoked_at IS NULL
    `;
	}

	async revokeByUser(userId: string): Promise<number> {
		await this._ready;
		const db = this.database;
		const now = this.now();
		const result = await db<GrantRow[]>`
      UPDATE fs_access_grants SET revoked_at = ${now}
      WHERE user_id = ${userId} AND revoked_at IS NULL
      RETURNING link_uuid
    `;
		return result.length;
	}

	async listActive(userId: string): Promise<AccessGrant[]> {
		await this._ready;
		const db = this.database;
		const now = this.now();
		const rows = await db<GrantRow[]>`
      SELECT * FROM fs_access_grants
      WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > ${now}
      ORDER BY created_at DESC
    `;
		return rows.map(rowToGrant);
	}

	async sweepExpired(): Promise<number> {
		await this._ready;
		const db = this.database;
		const now = this.now();
		const result = await db<GrantRow[]>`
      DELETE FROM fs_access_grants WHERE expires_at <= ${now} RETURNING link_uuid
    `;
		return result.length;
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
