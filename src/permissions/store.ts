import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
	dbPath: string;
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
	private readonly database: Database;

	constructor(options: PermissionsStoreOptions) {
		if (options.dbPath !== ":memory:") {
			mkdirSync(dirname(options.dbPath), { recursive: true });
		}
		this.database = new Database(options.dbPath, { create: true });
		this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS harness_users (
        id TEXT PRIMARY KEY,
        entrypoint TEXT NOT NULL,
        external_id TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        UNIQUE(entrypoint, external_id)
      );
      CREATE TABLE IF NOT EXISTS tool_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES harness_users(id) ON DELETE CASCADE,
        priority INTEGER NOT NULL DEFAULT 100,
        tool_name TEXT NOT NULL,
        args_matcher TEXT,
        decision TEXT NOT NULL CHECK(decision IN ('allow','ask','deny'))
      );
      CREATE INDEX IF NOT EXISTS idx_tool_permissions_user
        ON tool_permissions(user_id, priority);
    `);
	}

	getUser(entrypoint: Entrypoint, externalId: string): UserRecord | null {
		const row = this.database
			.query<UserRow, [string, string]>(
				`SELECT id, entrypoint, external_id, display_name, status, created_at
           FROM harness_users WHERE entrypoint = ?1 AND external_id = ?2`,
			)
			.get(entrypoint, externalId);
		return row ? rowToUser(row) : null;
	}

	getUserById(userId: string): UserRecord | null {
		const row = this.database
			.query<UserRow, [string]>(
				`SELECT id, entrypoint, external_id, display_name, status, created_at
           FROM harness_users WHERE id = ?1`,
			)
			.get(userId);
		return row ? rowToUser(row) : null;
	}

	listUsers(): UserRecord[] {
		return this.database
			.query<UserRow, []>(
				`SELECT id, entrypoint, external_id, display_name, status, created_at
           FROM harness_users ORDER BY created_at ASC`,
			)
			.all()
			.map(rowToUser);
	}

	upsertUser(params: {
		entrypoint: Entrypoint;
		externalId: string;
		displayName?: string | null;
	}): UserRecord {
		const id = callerId(params.entrypoint, params.externalId);
		const now = Date.now();
		this.database
			.query<never, [string, string, string, string | null, number]>(
				`INSERT INTO harness_users (id, entrypoint, external_id, display_name, status, created_at)
           VALUES (?1, ?2, ?3, ?4, 'active', ?5)
           ON CONFLICT(id) DO UPDATE SET display_name = COALESCE(excluded.display_name, harness_users.display_name)`,
			)
			.run(
				id,
				params.entrypoint,
				params.externalId,
				params.displayName ?? null,
				now,
			);
		const user = this.getUserById(id);
		if (!user) throw new Error(`Failed to upsert user ${id}`);
		return user;
	}

	setUserStatus(userId: string, status: UserStatus): void {
		this.database
			.query<never, [string, string]>(
				`UPDATE harness_users SET status = ?2 WHERE id = ?1`,
			)
			.run(userId, status);
	}

	listRulesForUser(userId: string): ToolRule[] {
		return this.database
			.query<RuleRow, [string]>(
				`SELECT id, user_id, priority, tool_name, args_matcher, decision
           FROM tool_permissions WHERE user_id = ?1 ORDER BY priority ASC, id ASC`,
			)
			.all(userId)
			.map(rowToRule);
	}

	upsertRule(userId: string, rule: NewToolRule): ToolRule {
		const argsJson = normalizeMatcher(rule.args);
		const selectStatement = this.database.query<
			RuleRow,
			[string, string, string | null]
		>(
			`SELECT id, user_id, priority, tool_name, args_matcher, decision
         FROM tool_permissions
         WHERE user_id = ?1 AND tool_name = ?2 AND IFNULL(args_matcher, '') = IFNULL(?3, '')`,
		);
		const existing = selectStatement.get(userId, rule.toolName, argsJson);

		if (existing) {
			this.database
				.query<never, [number, string, number]>(
					`UPDATE tool_permissions SET decision = ?2, priority = ?3 WHERE id = ?1`,
				)
				.run(existing.id, rule.decision, rule.priority);
		} else {
			this.database
				.query<never, [string, number, string, string | null, string]>(
					`INSERT INTO tool_permissions (user_id, priority, tool_name, args_matcher, decision)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
				)
				.run(userId, rule.priority, rule.toolName, argsJson, rule.decision);
		}

		const row = selectStatement.get(userId, rule.toolName, argsJson);
		if (!row) throw new Error("Failed to upsert rule");
		return rowToRule(row);
	}

	deleteMatchingRules(
		userId: string,
		toolName: string,
		args: ArgumentMatcher | null,
	): number {
		const argsJson = normalizeMatcher(args);
		const result = this.database
			.query<never, [string, string, string | null]>(
				`DELETE FROM tool_permissions
           WHERE user_id = ?1 AND tool_name = ?2 AND IFNULL(args_matcher, '') = IFNULL(?3, '')`,
			)
			.run(userId, toolName, argsJson);
		return Number(result.changes);
	}

	deleteAllRulesForUser(userId: string): number {
		const result = this.database
			.query<never, [string]>(`DELETE FROM tool_permissions WHERE user_id = ?1`)
			.run(userId);
		return Number(result.changes);
	}

	ensureUser(caller: Caller): UserRecord {
		const existing = this.getUser(caller.entrypoint, caller.externalId);
		if (existing) return existing;
		return this.upsertUser({
			entrypoint: caller.entrypoint,
			externalId: caller.externalId,
			displayName: caller.displayName ?? null,
		});
	}

	close(): void {
		this.database.close();
	}
}
