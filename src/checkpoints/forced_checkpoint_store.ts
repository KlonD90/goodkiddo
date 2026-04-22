// Stores structured forced-checkpoint records separately from raw LangGraph
// message history. Each record captures a summary snapshot at a defined
// compaction boundary (e.g. /new_thread, token limit exceeded, session resume).
//
// Schema is intentionally flat — the summary payload is a JSON string so the
// table remains portable across SQLite and Postgres without a jsonb dependency.

import { randomUUID } from "node:crypto";

type SQL = InstanceType<typeof Bun.SQL>;

export type SourceBoundary =
	| "new_thread"
	| "token_limit"
	| "message_limit"
	| "oversized_attachment"
	| "session_resume"
	| "explicit";

export type ForcedCheckpoint = {
	id: string;
	caller: string;
	threadId: string;
	createdAt: string;
	sourceBoundary: SourceBoundary;
	summaryPayload: string;
};

export type CreateForcedCheckpointInput = {
	caller: string;
	threadId: string;
	sourceBoundary: SourceBoundary;
	summaryPayload: string;
};

type RawRow = {
	id: string;
	caller: string;
	thread_id: string;
	created_at: string;
	source_boundary: string;
	summary_payload: string;
};

function toForcedCheckpoint(row: RawRow): ForcedCheckpoint {
	return {
		id: row.id,
		caller: row.caller,
		threadId: row.thread_id,
		createdAt: row.created_at,
		sourceBoundary: row.source_boundary as SourceBoundary,
		summaryPayload: row.summary_payload,
	};
}

export class ForcedCheckpointStore {
	private readonly db: SQL;
	private readonly _ready: Promise<void>;

	constructor(db: SQL) {
		this.db = db;
		this._ready = this.init();
		this._ready.catch(() => {});
	}

	private async init(): Promise<void> {
		await this.db`
			CREATE TABLE IF NOT EXISTS forced_checkpoints (
				id TEXT NOT NULL PRIMARY KEY,
				caller TEXT NOT NULL,
				thread_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				source_boundary TEXT NOT NULL,
				summary_payload TEXT NOT NULL
			)
		`;
		await this.db`
			CREATE INDEX IF NOT EXISTS idx_forced_checkpoints_caller_thread
			ON forced_checkpoints(caller, thread_id, created_at DESC)
		`;
	}

	async ready(): Promise<void> {
		return this._ready;
	}

	async create(input: CreateForcedCheckpointInput): Promise<ForcedCheckpoint> {
		await this._ready;
		const id = randomUUID();
		const createdAt = new Date().toISOString();

		await this.db`
			INSERT INTO forced_checkpoints (
				id,
				caller,
				thread_id,
				created_at,
				source_boundary,
				summary_payload
			) VALUES (
				${id},
				${input.caller},
				${input.threadId},
				${createdAt},
				${input.sourceBoundary},
				${input.summaryPayload}
			)
		`;

		return {
			id,
			caller: input.caller,
			threadId: input.threadId,
			createdAt,
			sourceBoundary: input.sourceBoundary,
			summaryPayload: input.summaryPayload,
		};
	}

	async readLatest(
		caller: string,
		threadId: string,
	): Promise<ForcedCheckpoint | null> {
		await this._ready;
		const rows = await this.db<RawRow[]>`
			SELECT
				id,
				caller,
				thread_id,
				created_at,
				source_boundary,
				summary_payload
			FROM forced_checkpoints
			WHERE caller = ${caller}
				AND thread_id = ${threadId}
			ORDER BY created_at DESC
			LIMIT 1
		`;
		return rows[0] ? toForcedCheckpoint(rows[0]) : null;
	}

	async readLatestForCaller(caller: string): Promise<ForcedCheckpoint | null> {
		await this._ready;
		const rows = await this.db<RawRow[]>`
			SELECT
				id,
				caller,
				thread_id,
				created_at,
				source_boundary,
				summary_payload
			FROM forced_checkpoints
			WHERE caller = ${caller}
			ORDER BY created_at DESC
			LIMIT 1
		`;
		return rows[0] ? toForcedCheckpoint(rows[0]) : null;
	}

	async listForThread(
		caller: string,
		threadId: string,
	): Promise<ForcedCheckpoint[]> {
		await this._ready;
		const rows = await this.db<RawRow[]>`
			SELECT
				id,
				caller,
				thread_id,
				created_at,
				source_boundary,
				summary_payload
			FROM forced_checkpoints
			WHERE caller = ${caller}
				AND thread_id = ${threadId}
			ORDER BY created_at DESC
		`;
		return rows.map(toForcedCheckpoint);
	}
}
