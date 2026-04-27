type SQL = InstanceType<typeof Bun.SQL>;

type ActiveThreadRow = {
	caller: string;
	active_thread_id: string;
	updated_at: string;
};

export class ActiveThreadStore {
	private readonly db: SQL;
	private readonly _ready: Promise<void>;

	constructor(db: SQL) {
		this.db = db;
		this._ready = this.init();
		this._ready.catch(() => {});
	}

	private async init(): Promise<void> {
		await this.db`
			CREATE TABLE IF NOT EXISTS active_threads (
				caller TEXT NOT NULL PRIMARY KEY,
				active_thread_id TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`;
	}

	async ready(): Promise<void> {
		await this._ready;
	}

	async getOrCreate(caller: string, defaultThreadId: string): Promise<string> {
		await this._ready;
		const rows = await this.db<ActiveThreadRow[]>`
			SELECT caller, active_thread_id, updated_at
			FROM active_threads
			WHERE caller = ${caller}
			LIMIT 1
		`;
		const existing = rows[0];
		if (existing) return existing.active_thread_id;

		await this.setActiveThread(caller, defaultThreadId);
		return defaultThreadId;
	}

	async setActiveThread(caller: string, threadId: string): Promise<void> {
		await this._ready;
		const updatedAt = new Date().toISOString();

		await this.db`
			INSERT INTO active_threads (
				caller,
				active_thread_id,
				updated_at
			) VALUES (
				${caller},
				${threadId},
				${updatedAt}
			)
			ON CONFLICT(caller)
			DO UPDATE SET
				active_thread_id = excluded.active_thread_id,
				updated_at = excluded.updated_at
		`;
	}
}
