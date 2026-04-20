import type { RunnableConfig } from "@langchain/core/runnables";
import {
	type BaseCheckpointSaver,
	type Checkpoint,
	type CheckpointMetadata,
	type CheckpointTuple,
	MemorySaver,
} from "@langchain/langgraph";
import type {
	CheckpointListOptions,
	PendingWrite,
} from "@langchain/langgraph-checkpoint";

type SQL = InstanceType<typeof Bun.SQL>;

const ERROR_CHANNEL = "__error__";
const SCHEDULED_CHANNEL = "__scheduled__";
const INTERRUPT_CHANNEL = "__interrupt__";
const RESUME_CHANNEL = "__resume__";

const WRITE_INDEX_BY_CHANNEL: Record<string, number> = {
	[ERROR_CHANNEL]: -1,
	[SCHEDULED_CHANNEL]: -2,
	[INTERRUPT_CHANNEL]: -3,
	[RESUME_CHANNEL]: -4,
};

type SqlBinary = Uint8Array | ArrayBuffer | string;

type SerializedRow = {
	type: string;
	data: Uint8Array;
};

type CheckpointRow = {
	checkpoint_type: string;
	checkpoint_data: SqlBinary;
	metadata_type: string;
	metadata_data: SqlBinary;
	parent_checkpoint_id: string | null;
};

type CheckpointLookupRow = CheckpointRow & {
	thread_id: string;
	checkpoint_ns: string;
	checkpoint_id: string;
};

type PendingWriteRow = {
	task_id: string;
	channel: string;
	value_type: string;
	value_data: SqlBinary;
	write_idx: number;
};

function getCheckpointId(config: RunnableConfig): string {
	return (
		(config.configurable?.checkpoint_id as string | undefined) ||
		(config.configurable?.thread_ts as string | undefined) ||
		""
	);
}

function toBytes(value: Uint8Array | ArrayBuffer | string): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return new TextEncoder().encode(value);
}

function metadataMatchesFilter(
	metadata: CheckpointMetadata | undefined,
	filter: Record<string, unknown> | undefined,
): boolean {
	if (!filter) return true;
	if (!metadata) return false;
	return Object.entries(filter).every(
		([key, value]) => metadata[key as keyof CheckpointMetadata] === value,
	);
}

export class SqlSaver extends MemorySaver {
	public readonly db: SQL;

	private readonly dialect: "sqlite" | "postgres";
	private readonly _ready: Promise<void>;

	constructor(db: SQL, dialect: "sqlite" | "postgres") {
		super();
		this.db = db;
		this.dialect = dialect;
		this._ready = this.init();
		this._ready.catch(() => {});
	}

	private async init(): Promise<void> {
		const binaryType = this.dialect === "postgres" ? "BYTEA" : "BLOB";
		if (this.dialect === "sqlite") {
			await this.db`PRAGMA journal_mode = WAL`;
		}

		await this.db.unsafe(`
			CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL,
				checkpoint_id TEXT NOT NULL,
				checkpoint_type TEXT NOT NULL,
				checkpoint_data ${binaryType} NOT NULL,
				metadata_type TEXT NOT NULL,
				metadata_data ${binaryType} NOT NULL,
				parent_checkpoint_id TEXT,
				PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
			)
		`);
		await this.db`
			CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_lookup
			ON langgraph_checkpoints(thread_id, checkpoint_ns, checkpoint_id)
		`;
		await this.db.unsafe(`
			CREATE TABLE IF NOT EXISTS langgraph_checkpoint_writes (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL,
				checkpoint_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				write_idx INTEGER NOT NULL,
				channel TEXT NOT NULL,
				value_type TEXT NOT NULL,
				value_data ${binaryType} NOT NULL,
				PRIMARY KEY (
					thread_id,
					checkpoint_ns,
					checkpoint_id,
					task_id,
					write_idx
				)
			)
		`);
		await this.db`
			CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoint_writes_lookup
			ON langgraph_checkpoint_writes(thread_id, checkpoint_ns, checkpoint_id)
		`;
	}

	close(): void {
		// No-op: lifecycle is managed by the injected db connection.
	}

	private async serialize(value: unknown): Promise<SerializedRow> {
		const [type, data] = await this.serde.dumpsTyped(value);
		return {
			type,
			data: toBytes(data),
		};
	}

	private async deserialize<T>(row: SerializedRow): Promise<T> {
		return (await this.serde.loadsTyped(row.type, row.data)) as T;
	}

	private async readPendingWrites(
		threadId: string,
		checkpointNamespace: string,
		checkpointId: string,
	): Promise<PendingWriteRow[]> {
		await this._ready;
		return this.db<PendingWriteRow[]>`
			SELECT
				task_id,
				channel,
				value_type,
				value_data,
				write_idx
			FROM langgraph_checkpoint_writes
			WHERE thread_id = ${threadId}
				AND checkpoint_ns = ${checkpointNamespace}
				AND checkpoint_id = ${checkpointId}
			ORDER BY task_id ASC, write_idx ASC
		`;
	}

	private async buildCheckpointTuple(
		threadId: string,
		checkpointNamespace: string,
		checkpointId: string,
		row: CheckpointRow,
	): Promise<CheckpointTuple> {
		const pendingWrites = await Promise.all(
			(await this.readPendingWrites(threadId, checkpointNamespace, checkpointId)).map(
				async (write) =>
					[
						write.task_id,
						write.channel,
						await this.deserialize({
							type: write.value_type,
							data: toBytes(write.value_data),
						}),
					] as [string, string, unknown],
			),
		);

		const checkpoint = await this.deserialize<Checkpoint>({
			type: row.checkpoint_type,
			data: toBytes(row.checkpoint_data),
		});
		const metadata = await this.deserialize<CheckpointMetadata>({
			type: row.metadata_type,
			data: toBytes(row.metadata_data),
		});

		const tuple: CheckpointTuple = {
			config: {
				configurable: {
					thread_id: threadId,
					checkpoint_ns: checkpointNamespace,
					checkpoint_id: checkpointId,
				},
			},
			checkpoint,
			metadata,
			pendingWrites,
		};

		if (row.parent_checkpoint_id) {
			tuple.parentConfig = {
				configurable: {
					thread_id: threadId,
					checkpoint_ns: checkpointNamespace,
					checkpoint_id: row.parent_checkpoint_id,
				},
			};
		}

		return tuple;
	}

	async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
		await this._ready;
		const threadId = config.configurable?.thread_id as string | undefined;
		if (!threadId) return undefined;

		const checkpointNamespace =
			(config.configurable?.checkpoint_ns as string | undefined) ?? "";
		const checkpointId = getCheckpointId(config);

		if (checkpointId) {
			const rows = await this.db<CheckpointRow[]>`
				SELECT
					checkpoint_type,
					checkpoint_data,
					metadata_type,
					metadata_data,
					parent_checkpoint_id
				FROM langgraph_checkpoints
				WHERE thread_id = ${threadId}
					AND checkpoint_ns = ${checkpointNamespace}
					AND checkpoint_id = ${checkpointId}
			`;
			const row = rows[0] ?? null;
			if (!row) return undefined;
			return this.buildCheckpointTuple(
				threadId,
				checkpointNamespace,
				checkpointId,
				row,
			);
		}

		const latestRows = await this.db<(CheckpointRow & { checkpoint_id: string })[]>`
			SELECT
				checkpoint_id,
				checkpoint_type,
				checkpoint_data,
				metadata_type,
				metadata_data,
				parent_checkpoint_id
			FROM langgraph_checkpoints
			WHERE thread_id = ${threadId}
				AND checkpoint_ns = ${checkpointNamespace}
			ORDER BY checkpoint_id DESC
			LIMIT 1
		`;
		const latest = latestRows[0] ?? null;
		if (!latest) return undefined;

		return this.buildCheckpointTuple(
			threadId,
			checkpointNamespace,
			latest.checkpoint_id,
			latest,
		);
	}

	async *list(
		config: RunnableConfig,
		options?: CheckpointListOptions,
	): AsyncGenerator<CheckpointTuple> {
		await this._ready;
		const requestedThreadId = config.configurable?.thread_id as
			| string
			| undefined;
		const requestedNamespace = config.configurable?.checkpoint_ns as
			| string
			| undefined;
		const requestedCheckpointId = config.configurable?.checkpoint_id as
			| string
			| undefined;
		const beforeCheckpointId = options?.before?.configurable?.checkpoint_id as
			| string
			| undefined;

		const rows = await this.db<CheckpointLookupRow[]>`
			SELECT
				thread_id,
				checkpoint_ns,
				checkpoint_id,
				checkpoint_type,
				checkpoint_data,
				metadata_type,
				metadata_data,
				parent_checkpoint_id
			FROM langgraph_checkpoints
			ORDER BY thread_id ASC, checkpoint_ns ASC, checkpoint_id DESC
		`;

		let remaining = options?.limit;
		for (const row of rows) {
			if (requestedThreadId && row.thread_id !== requestedThreadId) continue;
			if (
				requestedNamespace !== undefined &&
				row.checkpoint_ns !== requestedNamespace
			) {
				continue;
			}
			if (
				requestedCheckpointId !== undefined &&
				row.checkpoint_id !== requestedCheckpointId
			) {
				continue;
			}
			if (
				beforeCheckpointId !== undefined &&
				row.checkpoint_id >= beforeCheckpointId
			) {
				continue;
			}

			const tuple = await this.buildCheckpointTuple(
				row.thread_id,
				row.checkpoint_ns,
				row.checkpoint_id,
				row,
			);
			if (!metadataMatchesFilter(tuple.metadata, options?.filter)) continue;

			yield tuple;
			if (remaining !== undefined) {
				remaining -= 1;
				if (remaining <= 0) break;
			}
		}
	}

	async put(
		config: RunnableConfig,
		checkpoint: Checkpoint,
		metadata: CheckpointMetadata,
	): Promise<RunnableConfig> {
		await this._ready;
		const threadId = config.configurable?.thread_id as string | undefined;
		if (!threadId) {
			throw new Error(
				'Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.',
			);
		}

		const checkpointNamespace =
			(config.configurable?.checkpoint_ns as string | undefined) ?? "";
		const serializedCheckpoint = await this.serialize(checkpoint);
		const serializedMetadata = await this.serialize(metadata);
		const parentCheckpointId =
			(config.configurable?.checkpoint_id as string | undefined) ?? null;

		await this.db`
			INSERT INTO langgraph_checkpoints (
				thread_id,
				checkpoint_ns,
				checkpoint_id,
				checkpoint_type,
				checkpoint_data,
				metadata_type,
				metadata_data,
				parent_checkpoint_id
			) VALUES (
				${threadId},
				${checkpointNamespace},
				${checkpoint.id},
				${serializedCheckpoint.type},
				${serializedCheckpoint.data},
				${serializedMetadata.type},
				${serializedMetadata.data},
				${parentCheckpointId}
			)
			ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id)
			DO UPDATE SET
				checkpoint_type = excluded.checkpoint_type,
				checkpoint_data = excluded.checkpoint_data,
				metadata_type = excluded.metadata_type,
				metadata_data = excluded.metadata_data,
				parent_checkpoint_id = excluded.parent_checkpoint_id
		`;

		return {
			configurable: {
				thread_id: threadId,
				checkpoint_ns: checkpointNamespace,
				checkpoint_id: checkpoint.id,
			},
		};
	}

	async putWrites(
		config: RunnableConfig,
		writes: PendingWrite[],
		taskId: string,
	): Promise<void> {
		await this._ready;
		const threadId = config.configurable?.thread_id as string | undefined;
		if (!threadId) {
			throw new Error(
				'Failed to put writes. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property',
			);
		}

		const checkpointNamespace =
			(config.configurable?.checkpoint_ns as string | undefined) ?? "";
		const checkpointId = config.configurable?.checkpoint_id as
			| string
			| undefined;
		if (!checkpointId) {
			throw new Error(
				'Failed to put writes. The passed RunnableConfig is missing a required "checkpoint_id" field in its "configurable" property.',
			);
		}

		for (const [index, [channel, value]] of writes.entries()) {
			const writeIndex = WRITE_INDEX_BY_CHANNEL[channel] ?? index;
			if (writeIndex >= 0) {
				const existingRows = await this.db<Array<{ present: number }>>`
					SELECT 1 AS present
					FROM langgraph_checkpoint_writes
					WHERE thread_id = ${threadId}
						AND checkpoint_ns = ${checkpointNamespace}
						AND checkpoint_id = ${checkpointId}
						AND task_id = ${taskId}
						AND write_idx = ${writeIndex}
				`;
				if (existingRows.length > 0) continue;
			}

			const serialized = await this.serialize(value);
			await this.db`
				INSERT INTO langgraph_checkpoint_writes (
					thread_id,
					checkpoint_ns,
					checkpoint_id,
					task_id,
					write_idx,
					channel,
					value_type,
					value_data
				) VALUES (
					${threadId},
					${checkpointNamespace},
					${checkpointId},
					${taskId},
					${writeIndex},
					${channel},
					${serialized.type},
					${serialized.data}
				)
				ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx)
				DO UPDATE SET
					channel = excluded.channel,
					value_type = excluded.value_type,
					value_data = excluded.value_data
			`;
		}
	}

	async deleteThread(threadId: string): Promise<void> {
		await this._ready;
		await this.db`
			DELETE FROM langgraph_checkpoint_writes WHERE thread_id = ${threadId}
		`;
		await this.db`
			DELETE FROM langgraph_checkpoints WHERE thread_id = ${threadId}
		`;
	}
}

export function createPersistentCheckpointer(
	db: SQL,
	dialect: "sqlite" | "postgres",
): BaseCheckpointSaver {
	return new SqlSaver(db, dialect);
}
