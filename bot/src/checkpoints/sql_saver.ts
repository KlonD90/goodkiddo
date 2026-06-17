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
import type { AppPrisma } from "../db/prisma";

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

type PrismaBytes = Uint8Array<ArrayBuffer>;
type SqlBinary = Uint8Array | ArrayBuffer | string;

type SerializedRow = {
	type: string;
	data: PrismaBytes;
};

type CheckpointRow = {
	checkpointType: string;
	checkpointData: SqlBinary;
	metadataType: string;
	metadataData: SqlBinary;
	parentCheckpointId: string | null;
};

type PendingWriteRow = {
	taskId: string;
	channel: string;
	valueType: string;
	valueData: SqlBinary;
	writeIdx: number;
};

function getCheckpointId(config: RunnableConfig): string {
	return (
		(config.configurable?.checkpoint_id as string | undefined) ||
		(config.configurable?.thread_ts as string | undefined) ||
		""
	);
}

function toBytes(value: Uint8Array | ArrayBuffer | string): PrismaBytes {
	if (value instanceof Uint8Array) {
		return new Uint8Array(Array.from(value));
	}
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
	public readonly prisma: AppPrisma;

	constructor(prisma: AppPrisma) {
		super();
		this.prisma = prisma;
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
		return this.prisma.langGraphCheckpointWrite.findMany({
			where: {
				threadId,
				checkpointNs: checkpointNamespace,
				checkpointId,
			},
			orderBy: [{ taskId: "asc" }, { writeIdx: "asc" }],
		});
	}

	private async buildCheckpointTuple(
		threadId: string,
		checkpointNamespace: string,
		checkpointId: string,
		row: CheckpointRow,
	): Promise<CheckpointTuple> {
		const pendingWrites = await Promise.all(
			(
				await this.readPendingWrites(
					threadId,
					checkpointNamespace,
					checkpointId,
				)
			).map(
				async (write) =>
					[
						write.taskId,
						write.channel,
						await this.deserialize({
							type: write.valueType,
							data: toBytes(write.valueData),
						}),
					] as [string, string, unknown],
			),
		);

		const checkpoint = await this.deserialize<Checkpoint>({
			type: row.checkpointType,
			data: toBytes(row.checkpointData),
		});
		const metadata = await this.deserialize<CheckpointMetadata>({
			type: row.metadataType,
			data: toBytes(row.metadataData),
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

		if (row.parentCheckpointId) {
			tuple.parentConfig = {
				configurable: {
					thread_id: threadId,
					checkpoint_ns: checkpointNamespace,
					checkpoint_id: row.parentCheckpointId,
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
			const row = await this.prisma.langGraphCheckpoint.findUnique({
				where: {
					threadId_checkpointNs_checkpointId: {
						threadId,
						checkpointNs: checkpointNamespace,
						checkpointId,
					},
				},
			});
			if (!row) return undefined;
			return this.buildCheckpointTuple(
				threadId,
				checkpointNamespace,
				checkpointId,
				row,
			);
		}

		const latest = await this.prisma.langGraphCheckpoint.findFirst({
			where: { threadId, checkpointNs: checkpointNamespace },
			orderBy: { checkpointId: "desc" },
		});
		if (!latest) return undefined;

		return this.buildCheckpointTuple(
			threadId,
			checkpointNamespace,
			latest.checkpointId,
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

		const rows = await this.prisma.langGraphCheckpoint.findMany({
			orderBy: [
				{ threadId: "asc" },
				{ checkpointNs: "asc" },
				{ checkpointId: "desc" },
			],
		});

		let remaining = options?.limit;
		for (const row of rows) {
			if (requestedThreadId && row.threadId !== requestedThreadId) continue;
			if (
				requestedNamespace !== undefined &&
				row.checkpointNs !== requestedNamespace
			) {
				continue;
			}
			if (
				requestedCheckpointId !== undefined &&
				row.checkpointId !== requestedCheckpointId
			) {
				continue;
			}
			if (
				beforeCheckpointId !== undefined &&
				row.checkpointId >= beforeCheckpointId
			) {
				continue;
			}

			const tuple = await this.buildCheckpointTuple(
				row.threadId,
				row.checkpointNs,
				row.checkpointId,
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

		await this.prisma.langGraphCheckpoint.upsert({
			where: {
				threadId_checkpointNs_checkpointId: {
					threadId,
					checkpointNs: checkpointNamespace,
					checkpointId: checkpoint.id,
				},
			},
			update: {
				checkpointType: serializedCheckpoint.type,
				checkpointData: serializedCheckpoint.data,
				metadataType: serializedMetadata.type,
				metadataData: serializedMetadata.data,
				parentCheckpointId,
			},
			create: {
				threadId,
				checkpointNs: checkpointNamespace,
				checkpointId: checkpoint.id,
				checkpointType: serializedCheckpoint.type,
				checkpointData: serializedCheckpoint.data,
				metadataType: serializedMetadata.type,
				metadataData: serializedMetadata.data,
				parentCheckpointId,
			},
		});

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
			if (writeIndex >= 0) {
				const existing = await this.prisma.langGraphCheckpointWrite.findUnique({
					where: {
						threadId_checkpointNs_checkpointId_taskId_writeIdx: {
							threadId,
							checkpointNs: checkpointNamespace,
							checkpointId,
							taskId,
							writeIdx: writeIndex,
						},
					},
				});
				if (existing) continue;
			}

			const serialized = await this.serialize(value);
			await this.prisma.langGraphCheckpointWrite.upsert({
				where: {
					threadId_checkpointNs_checkpointId_taskId_writeIdx: {
						threadId,
						checkpointNs: checkpointNamespace,
						checkpointId,
						taskId,
						writeIdx: writeIndex,
					},
				},
				update: {
					channel,
					valueType: serialized.type,
					valueData: serialized.data,
				},
				create: {
					threadId,
					checkpointNs: checkpointNamespace,
					checkpointId,
					taskId,
					writeIdx: writeIndex,
					channel,
					valueType: serialized.type,
					valueData: serialized.data,
				},
			});
		}
	}

	async deleteThread(threadId: string): Promise<void> {
		await this.prisma.langGraphCheckpointWrite.deleteMany({
			where: { threadId },
		});
		await this.prisma.langGraphCheckpoint.deleteMany({
			where: { threadId },
		});
	}
}

export function createPersistentCheckpointer(
	prisma: AppPrisma,
): BaseCheckpointSaver {
	return new SqlSaver(prisma);
}
