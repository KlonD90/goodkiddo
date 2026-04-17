import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
	type BaseCheckpointSaver,
	type ChannelVersions,
	type Checkpoint,
	type CheckpointListOptions,
	type CheckpointMetadata,
	type CheckpointTuple,
	MemorySaver,
	type PendingWrite,
} from "@langchain/langgraph";

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

type SerializedRow = {
	type: string;
	data: Uint8Array;
};

type CheckpointRow = {
	checkpoint_type: string;
	checkpoint_data: Uint8Array;
	metadata_type: string;
	metadata_data: Uint8Array;
	parent_checkpoint_id: string | null;
};

type PendingWriteRow = {
	task_id: string;
	channel: string;
	value_type: string;
	value_data: Uint8Array;
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

export class BunSqliteSaver extends MemorySaver {
	public readonly db: Database;

	constructor(dbOrPath: Database | string) {
		super();

		if (typeof dbOrPath === "string") {
			if (dbOrPath !== ":memory:") {
				mkdirSync(dirname(dbOrPath), { recursive: true });
			}
			this.db = new Database(dbOrPath, { create: true });
		} else {
			this.db = dbOrPath;
		}

		this.db.exec(`
			PRAGMA journal_mode = WAL;

			CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL,
				checkpoint_id TEXT NOT NULL,
				checkpoint_type TEXT NOT NULL,
				checkpoint_data BLOB NOT NULL,
				metadata_type TEXT NOT NULL,
				metadata_data BLOB NOT NULL,
				parent_checkpoint_id TEXT,
				PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
			);

			CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_lookup
			ON langgraph_checkpoints(thread_id, checkpoint_ns, checkpoint_id);

			CREATE TABLE IF NOT EXISTS langgraph_checkpoint_writes (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL,
				checkpoint_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				write_idx INTEGER NOT NULL,
				channel TEXT NOT NULL,
				value_type TEXT NOT NULL,
				value_data BLOB NOT NULL,
				PRIMARY KEY (
					thread_id,
					checkpoint_ns,
					checkpoint_id,
					task_id,
					write_idx
				)
			);

			CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoint_writes_lookup
			ON langgraph_checkpoint_writes(thread_id, checkpoint_ns, checkpoint_id);
		`);
	}

	static fromConnString(path: string): BunSqliteSaver {
		return new BunSqliteSaver(path);
	}

	close(): void {
		this.db.close();
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

	private readPendingWrites(
		threadId: string,
		checkpointNamespace: string,
		checkpointId: string,
	): PendingWriteRow[] {
		return this.db
			.query<PendingWriteRow, [string, string, string]>(`
				SELECT
					task_id,
					channel,
					value_type,
					value_data,
					write_idx
				FROM langgraph_checkpoint_writes
				WHERE thread_id = ?1
					AND checkpoint_ns = ?2
					AND checkpoint_id = ?3
				ORDER BY task_id ASC, write_idx ASC
			`)
			.all(threadId, checkpointNamespace, checkpointId);
	}

	private async buildCheckpointTuple(
		threadId: string,
		checkpointNamespace: string,
		checkpointId: string,
		row: CheckpointRow,
	): Promise<CheckpointTuple> {
		const pendingWrites = await Promise.all(
			this.readPendingWrites(threadId, checkpointNamespace, checkpointId).map(
				async (write) =>
					[
						write.task_id,
						write.channel,
						await this.deserialize({
							type: write.value_type,
							data: write.value_data,
						}),
					] as [string, string, unknown],
			),
		);

		const checkpoint = await this.deserialize<Checkpoint>({
			type: row.checkpoint_type,
			data: row.checkpoint_data,
		});
		const metadata = await this.deserialize<CheckpointMetadata>({
			type: row.metadata_type,
			data: row.metadata_data,
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
		const threadId = config.configurable?.thread_id as string | undefined;
		if (!threadId) return undefined;

		const checkpointNamespace =
			(config.configurable?.checkpoint_ns as string | undefined) ?? "";
		const checkpointId = getCheckpointId(config);

		if (checkpointId) {
			const row =
				this.db
					.query<CheckpointRow, [string, string, string]>(`
						SELECT
							checkpoint_type,
							checkpoint_data,
							metadata_type,
							metadata_data,
							parent_checkpoint_id
						FROM langgraph_checkpoints
						WHERE thread_id = ?1
							AND checkpoint_ns = ?2
							AND checkpoint_id = ?3
					`)
					.get(threadId, checkpointNamespace, checkpointId) ?? null;
			if (!row) return undefined;
			return this.buildCheckpointTuple(
				threadId,
				checkpointNamespace,
				checkpointId,
				row,
			);
		}

		const latest =
			this.db
				.query<CheckpointRow & { checkpoint_id: string }, [string, string]>(`
					SELECT
						checkpoint_id,
						checkpoint_type,
						checkpoint_data,
						metadata_type,
						metadata_data,
						parent_checkpoint_id
					FROM langgraph_checkpoints
					WHERE thread_id = ?1
						AND checkpoint_ns = ?2
					ORDER BY checkpoint_id DESC
					LIMIT 1
				`)
				.get(threadId, checkpointNamespace) ?? null;
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

		const rows = this.db
			.query<
				CheckpointRow & {
					thread_id: string;
					checkpoint_ns: string;
					checkpoint_id: string;
				},
				[]
			>(`
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
			`)
			.all();

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
		_newVersions: ChannelVersions,
	): Promise<RunnableConfig> {
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

		this.db
			.prepare(`
				INSERT INTO langgraph_checkpoints (
					thread_id,
					checkpoint_ns,
					checkpoint_id,
					checkpoint_type,
					checkpoint_data,
					metadata_type,
					metadata_data,
					parent_checkpoint_id
				) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
				ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id)
				DO UPDATE SET
					checkpoint_type = excluded.checkpoint_type,
					checkpoint_data = excluded.checkpoint_data,
					metadata_type = excluded.metadata_type,
					metadata_data = excluded.metadata_data,
					parent_checkpoint_id = excluded.parent_checkpoint_id
			`)
			.run(
				threadId,
				checkpointNamespace,
				checkpoint.id,
				serializedCheckpoint.type,
				serializedCheckpoint.data,
				serializedMetadata.type,
				serializedMetadata.data,
				(config.configurable?.checkpoint_id as string | undefined) ?? null,
			);

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
			const existing =
				this.db
					.query<null, [string, string, string, string, number]>(`
						SELECT 1
						FROM langgraph_checkpoint_writes
						WHERE thread_id = ?1
							AND checkpoint_ns = ?2
							AND checkpoint_id = ?3
							AND task_id = ?4
							AND write_idx = ?5
					`)
					.get(
						threadId,
						checkpointNamespace,
						checkpointId,
						taskId,
						writeIndex,
					) ?? null;
			if (existing && writeIndex >= 0) continue;

			const serialized = await this.serialize(value);
			this.db
				.prepare(`
					INSERT INTO langgraph_checkpoint_writes (
						thread_id,
						checkpoint_ns,
						checkpoint_id,
						task_id,
						write_idx,
						channel,
						value_type,
						value_data
					) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
					ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx)
					DO UPDATE SET
						channel = excluded.channel,
						value_type = excluded.value_type,
						value_data = excluded.value_data
				`)
				.run(
					threadId,
					checkpointNamespace,
					checkpointId,
					taskId,
					writeIndex,
					channel,
					serialized.type,
					serialized.data,
				);
		}
	}

	async deleteThread(threadId: string): Promise<void> {
		this.db
			.prepare(`DELETE FROM langgraph_checkpoint_writes WHERE thread_id = ?1`)
			.run(threadId);
		this.db
			.prepare(`DELETE FROM langgraph_checkpoints WHERE thread_id = ?1`)
			.run(threadId);
	}
}

export function createPersistentCheckpointer(
	dbPath: string,
): BaseCheckpointSaver {
	return new BunSqliteSaver(dbPath);
}
