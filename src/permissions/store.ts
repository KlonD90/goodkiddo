import { normalizeMatcher } from "./matcher";
import {
	type ArgumentMatcher,
	type Caller,
	callerId,
	type Entrypoint,
	type NewToolRule,
	type PermissionDecision,
	type ToolRule,
	type UserRecord,
	type UserStatus,
} from "./types";

type SQL = InstanceType<typeof Bun.SQL>;

type UserRow = {
	id: string;
	entrypoint: string;
	external_id: string;
	display_name: string | null;
	status: string;
	created_at: number;
};

type RuleRow = {
	id: number;
	user_id: string;
	priority: number;
	tool_name: string;
	args_matcher: string | null;
	decision: string;
};

export interface PermissionsStoreOptions {
	db: SQL;
	dialect: "sqlite" | "postgres";
}

function rowToUser(row: UserRow): UserRecord {
	return {
		id: row.id,
		entrypoint: row.entrypoint as Entrypoint,
		externalId: row.external_id,
		displayName: row.display_name,
		status: row.status as UserStatus,
		createdAt: row.created_at,
	};
}

function rowToRule(row: RuleRow): ToolRule {
	return {
		id: row.id,
		userId: row.user_id,
		priority: row.priority,
		toolName: row.tool_name,
		args: row.args_matcher
			? (JSON.parse(row.args_matcher) as ArgumentMatcher)
			: null,
		decision: row.decision as PermissionDecision,
	};
}

export class PermissionsStore {
	private readonly database: SQL;
	private readonly dialect: "sqlite" | "postgres";
	private readonly _ready: Promise<void>;

	constructor(options: PermissionsStoreOptions) {
		this.database = options.db;
		this.dialect = options.dialect;
		this._ready = this._init();
	}

	private async _init(): Promise<void> {
		const db = this.database;
		await db`
      CREATE TABLE IF NOT EXISTS harness_users (
        id TEXT PRIMARY KEY,
        entrypoint TEXT NOT NULL,
        external_id TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        UNIQUE(entrypoint, external_id)
      )
    `;
		if (this.dialect === "postgres") {
			await db`
        CREATE TABLE IF NOT EXISTS tool_permissions (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES harness_users(id) ON DELETE CASCADE,
          priority INTEGER NOT NULL DEFAULT 100,
          tool_name TEXT NOT NULL,
          args_matcher TEXT,
          decision TEXT NOT NULL CHECK(decision IN ('allow','ask','deny'))
        )
      `;
		} else {
			await db`
        CREATE TABLE IF NOT EXISTS tool_permissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL REFERENCES harness_users(id) ON DELETE CASCADE,
          priority INTEGER NOT NULL DEFAULT 100,
          tool_name TEXT NOT NULL,
          args_matcher TEXT,
          decision TEXT NOT NULL CHECK(decision IN ('allow','ask','deny'))
        )
      `;
		}
		await db`
      CREATE INDEX IF NOT EXISTS idx_tool_permissions_user
        ON tool_permissions(user_id, priority)
    `;
		if (this.dialect === "sqlite") {
			await db`PRAGMA journal_mode = WAL`;
		}
	}

	async getUser(
		entrypoint: Entrypoint,
		externalId: string,
	): Promise<UserRecord | null> {
		await this._ready;
		const db = this.database;
		const rows = await db<UserRow[]>`
      SELECT id, entrypoint, external_id, display_name, status, created_at
      FROM harness_users WHERE entrypoint = ${entrypoint} AND external_id = ${externalId}
    `;
		return rows[0] ? rowToUser(rows[0]) : null;
	}

	async getUserById(userId: string): Promise<UserRecord | null> {
		await this._ready;
		const db = this.database;
		const rows = await db<UserRow[]>`
      SELECT id, entrypoint, external_id, display_name, status, created_at
      FROM harness_users WHERE id = ${userId}
    `;
		return rows[0] ? rowToUser(rows[0]) : null;
	}

	async listUsers(): Promise<UserRecord[]> {
		await this._ready;
		const db = this.database;
		const rows = await db<UserRow[]>`
      SELECT id, entrypoint, external_id, display_name, status, created_at
      FROM harness_users ORDER BY created_at ASC
    `;
		return rows.map(rowToUser);
	}

	async upsertUser(params: {
		entrypoint: Entrypoint;
		externalId: string;
		displayName?: string | null;
	}): Promise<UserRecord> {
		await this._ready;
		const id = callerId(params.entrypoint, params.externalId);
		const now = Date.now();
		const displayName = params.displayName ?? null;
		const db = this.database;
		await db`
      INSERT INTO harness_users (id, entrypoint, external_id, display_name, status, created_at)
      VALUES (${id}, ${params.entrypoint}, ${params.externalId}, ${displayName}, 'active', ${now})
      ON CONFLICT(id) DO UPDATE SET display_name = COALESCE(excluded.display_name, harness_users.display_name)
    `;
		const user = await this.getUserById(id);
		if (!user) throw new Error(`Failed to upsert user ${id}`);
		return user;
	}

	async setUserStatus(userId: string, status: UserStatus): Promise<void> {
		await this._ready;
		const db = this.database;
		await db`UPDATE harness_users SET status = ${status} WHERE id = ${userId}`;
	}

	async listRulesForUser(userId: string): Promise<ToolRule[]> {
		await this._ready;
		const db = this.database;
		const rows = await db<RuleRow[]>`
      SELECT id, user_id, priority, tool_name, args_matcher, decision
      FROM tool_permissions WHERE user_id = ${userId} ORDER BY priority ASC, id ASC
    `;
		return rows.map(rowToRule);
	}

	async upsertRule(userId: string, rule: NewToolRule): Promise<ToolRule> {
		await this._ready;
		const argsJson = normalizeMatcher(rule.args);
		const db = this.database;
		const existingRows = await db<RuleRow[]>`
      SELECT id, user_id, priority, tool_name, args_matcher, decision
      FROM tool_permissions
      WHERE user_id = ${userId} AND tool_name = ${rule.toolName}
        AND COALESCE(args_matcher, '') = COALESCE(${argsJson}, '')
    `;
		const existing = existingRows[0] ?? null;

		if (existing) {
			await db`
        UPDATE tool_permissions SET decision = ${rule.decision}, priority = ${rule.priority} WHERE id = ${existing.id}
      `;
		} else {
			await db`
        INSERT INTO tool_permissions (user_id, priority, tool_name, args_matcher, decision)
        VALUES (${userId}, ${rule.priority}, ${rule.toolName}, ${argsJson}, ${rule.decision})
      `;
		}

		const updatedRows = await db<RuleRow[]>`
      SELECT id, user_id, priority, tool_name, args_matcher, decision
      FROM tool_permissions
      WHERE user_id = ${userId} AND tool_name = ${rule.toolName}
        AND COALESCE(args_matcher, '') = COALESCE(${argsJson}, '')
    `;
		const row = updatedRows[0];
		if (!row) throw new Error("Failed to upsert rule");
		return rowToRule(row);
	}

	async deleteMatchingRules(
		userId: string,
		toolName: string,
		args: ArgumentMatcher | null,
	): Promise<number> {
		await this._ready;
		const argsJson = normalizeMatcher(args);
		const db = this.database;
		const result = await db<RuleRow[]>`
      DELETE FROM tool_permissions
      WHERE user_id = ${userId} AND tool_name = ${toolName}
        AND COALESCE(args_matcher, '') = COALESCE(${argsJson}, '')
      RETURNING id
    `;
		return result.length;
	}

	async deleteAllRulesForUser(userId: string): Promise<number> {
		await this._ready;
		const db = this.database;
		const result = await db<RuleRow[]>`
      DELETE FROM tool_permissions WHERE user_id = ${userId} RETURNING id
    `;
		return result.length;
	}

	async ensureUser(caller: Caller): Promise<UserRecord> {
		const existing = await this.getUser(caller.entrypoint, caller.externalId);
		if (existing) return existing;
		return this.upsertUser({
			entrypoint: caller.entrypoint,
			externalId: caller.externalId,
			displayName: caller.displayName ?? null,
		});
	}

	close(): void {
		// No-op: lifecycle is managed by the injected db connection
	}
}
