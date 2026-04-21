import { randomUUID } from "node:crypto";

type SQL = InstanceType<typeof Bun.SQL>;

export interface TimerRecord {
	id: string;
	userId: string;
	chatId: string;
	mdFilePath: string;
	cronExpression: string;
	timezone: string;
	enabled: boolean;
	lastRunAt: number | null;
	lastError: string | null;
	consecutiveFailures: number;
	nextRunAt: number;
	createdAt: number;
}

type TimerRow = {
	id: string;
	user_id: string;
	chat_id: string;
	md_file_path: string;
	cron_expression: string;
	timezone: string;
	enabled: number;
	last_run_at: number | null;
	last_error: string | null;
	consecutive_failures: number;
	next_run_at: number;
	created_at: number;
};

export interface TimerStoreOptions {
	db: SQL;
	dialect: "sqlite" | "postgres";
	now?: () => number;
}

export interface CreateTimerParams {
	userId: string;
	chatId: string;
	mdFilePath: string;
	cronExpression: string;
	timezone: string;
	nextRunAt: number;
}

export interface UpdateTimerParams {
	cronExpression?: string;
	timezone?: string;
	enabled?: boolean;
}

function rowToTimer(row: TimerRow): TimerRecord {
	return {
		id: row.id,
		userId: row.user_id,
		chatId: row.chat_id,
		mdFilePath: row.md_file_path,
		cronExpression: row.cron_expression,
		timezone: row.timezone,
		enabled: row.enabled === 1,
		lastRunAt: row.last_run_at,
		lastError: row.last_error,
		consecutiveFailures: row.consecutive_failures,
		nextRunAt: row.next_run_at,
		createdAt: row.created_at,
	};
}

export class TimerStore {
	private readonly db: SQL;
	private readonly dialect: "sqlite" | "postgres";
	private readonly now: () => number;
	private readonly _ready: Promise<void>;

	constructor(options: TimerStoreOptions) {
		this.db = options.db;
		this.dialect = options.dialect;
		this.now = options.now ?? (() => Date.now());
		this._ready = this.init();
		this._ready.catch((err) => {
			console.error("TimerStore initialization failed:", err);
		});
	}

	private async init(): Promise<void> {
		if (this.dialect === "postgres") {
			await this.db`
				CREATE TABLE IF NOT EXISTS timers (
					id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					chat_id TEXT NOT NULL,
					md_file_path TEXT NOT NULL,
					cron_expression TEXT NOT NULL,
					timezone TEXT NOT NULL DEFAULT 'UTC',
					enabled INTEGER NOT NULL DEFAULT 1,
					last_run_at BIGINT,
					last_error TEXT,
					consecutive_failures INTEGER NOT NULL DEFAULT 0,
					next_run_at BIGINT NOT NULL,
					created_at BIGINT NOT NULL
				)
			`;
		} else {
			await this.db`
				CREATE TABLE IF NOT EXISTS timers (
					id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					chat_id TEXT NOT NULL,
					md_file_path TEXT NOT NULL,
					cron_expression TEXT NOT NULL,
					timezone TEXT NOT NULL DEFAULT 'UTC',
					enabled INTEGER NOT NULL DEFAULT 1,
					last_run_at INTEGER,
					last_error TEXT,
					consecutive_failures INTEGER NOT NULL DEFAULT 0,
					next_run_at INTEGER NOT NULL,
					created_at INTEGER NOT NULL
				)
			`;
		}

		await this.db`
			CREATE INDEX IF NOT EXISTS idx_timers_enabled_next_run_at
			ON timers(enabled, next_run_at)
		`;

		if (this.dialect === "sqlite") {
			await this.db`PRAGMA journal_mode = WAL`;
		}
	}

	async ready(): Promise<void> {
		await this._ready;
	}

	async create(params: CreateTimerParams): Promise<TimerRecord> {
		await this._ready;
		const id = randomUUID();
		const now = this.now();
		const rows = await this.db<TimerRow[]>`
			INSERT INTO timers (
				id,
				user_id,
				chat_id,
				md_file_path,
				cron_expression,
				timezone,
				enabled,
				last_run_at,
				last_error,
				consecutive_failures,
				next_run_at,
				created_at
			) VALUES (
				${id},
				${params.userId},
				${params.chatId},
				${params.mdFilePath},
				${params.cronExpression},
				${params.timezone},
				1,
				NULL,
				NULL,
				0,
				${params.nextRunAt},
				${now}
			)
			RETURNING
				id,
				user_id,
				chat_id,
				md_file_path,
				cron_expression,
				timezone,
				enabled,
				last_run_at,
				last_error,
				consecutive_failures,
				next_run_at,
				created_at
		`;
		const row = rows[0];
		if (!row) throw new Error("Failed to create timer");
		return rowToTimer(row);
	}

	async findDue(): Promise<TimerRecord[]> {
		await this._ready;
		const now = this.now();
		const rows = await this.db<TimerRow[]>`
			SELECT
				id,
				user_id,
				chat_id,
				md_file_path,
				cron_expression,
				timezone,
				enabled,
				last_run_at,
				last_error,
				consecutive_failures,
				next_run_at,
				created_at
			FROM timers
			WHERE enabled = 1 AND next_run_at <= ${now}
			ORDER BY next_run_at ASC
		`;
		return rows.map(rowToTimer);
	}

	async findByUser(userId: string): Promise<TimerRecord[]> {
		await this._ready;
		const rows = await this.db<TimerRow[]>`
			SELECT
				id,
				user_id,
				chat_id,
				md_file_path,
				cron_expression,
				timezone,
				enabled,
				last_run_at,
				last_error,
				consecutive_failures,
				next_run_at,
				created_at
			FROM timers
			WHERE user_id = ${userId}
			ORDER BY created_at DESC
		`;
		return rows.map(rowToTimer);
	}

	async getById(id: string): Promise<TimerRecord | null> {
		await this._ready;
		const rows = await this.db<TimerRow[]>`
			SELECT
				id,
				user_id,
				chat_id,
				md_file_path,
				cron_expression,
				timezone,
				enabled,
				last_run_at,
				last_error,
				consecutive_failures,
				next_run_at,
				created_at
			FROM timers
			WHERE id = ${id}
			LIMIT 1
		`;
		return rows[0] ? rowToTimer(rows[0]) : null;
	}

	async update(
		id: string,
		userId: string,
		updates: UpdateTimerParams,
	): Promise<TimerRecord | null> {
		await this._ready;
		const existing = await this.getById(id);
		if (!existing || existing.userId !== userId) {
			return null;
		}

		const cronExpression = updates.cronExpression ?? existing.cronExpression;
		const timezone = updates.timezone ?? existing.timezone;
		const enabled = updates.enabled ?? existing.enabled;

		const rows = await this.db<TimerRow[]>`
			UPDATE timers
			SET
				cron_expression = ${cronExpression},
				timezone = ${timezone},
				enabled = ${enabled ? 1 : 0}
			WHERE id = ${id} AND user_id = ${userId}
			RETURNING
				id,
				user_id,
				chat_id,
				md_file_path,
				cron_expression,
				timezone,
				enabled,
				last_run_at,
				last_error,
				consecutive_failures,
				next_run_at,
				created_at
		`;
		return rows[0] ? rowToTimer(rows[0]) : null;
	}

	async delete(id: string, userId: string): Promise<boolean> {
		await this._ready;
		const result = await this.db<TimerRow[]>`
			DELETE FROM timers
			WHERE id = ${id} AND user_id = ${userId}
			RETURNING id
		`;
		return result.length > 0;
	}

	async touchRun(id: string, nextRunAt: number): Promise<void> {
		await this._ready;
		const now = this.now();
		await this.db`
			UPDATE timers
			SET
				last_run_at = ${now},
				last_error = NULL,
				consecutive_failures = 0,
				next_run_at = ${nextRunAt}
			WHERE id = ${id}
		`;
	}

	async touchError(id: string, error: string): Promise<number> {
		await this._ready;
		const now = this.now();
		const rows = await this.db<Array<{ consecutive_failures: number }>>`
			UPDATE timers
			SET
				last_error = ${error},
				consecutive_failures = consecutive_failures + 1
			WHERE id = ${id}
			RETURNING consecutive_failures
		`;
		return rows[0]?.consecutive_failures ?? 0;
	}

	close(): void {
		// No-op: lifecycle is managed by the injected db connection
	}
}
