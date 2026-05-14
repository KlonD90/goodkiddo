// Stores structured forced-checkpoint records separately from raw LangGraph
// message history. Each record captures a summary snapshot at a defined
// compaction boundary (e.g. /new_thread, token limit exceeded, session resume).
//
// Schema is intentionally flat — the summary payload is a JSON string so the
// table remains portable across SQLite and Postgres without a jsonb dependency.

import { randomUUID } from "node:crypto";
import type { AppPrisma } from "../db/prisma";

export type SourceBoundary =
	| "new_thread"
	| "token_limit"
	| "message_limit"
	| "oversized_attachment"
	| "session_resume"
	| "identity_change"
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

type ForcedCheckpointModel = {
	id: string;
	caller: string;
	threadId: string;
	createdAt: string;
	sourceBoundary: string;
	summaryPayload: string;
};

function toForcedCheckpoint(row: ForcedCheckpointModel): ForcedCheckpoint {
	return {
		id: row.id,
		caller: row.caller,
		threadId: row.threadId,
		createdAt: row.createdAt,
		sourceBoundary: row.sourceBoundary as SourceBoundary,
		summaryPayload: row.summaryPayload,
	};
}

export class ForcedCheckpointStore {
	private readonly prisma: AppPrisma;

	constructor(prisma: AppPrisma) {
		this.prisma = prisma;
	}

	async ready(): Promise<void> {
		return;
	}

	async create(input: CreateForcedCheckpointInput): Promise<ForcedCheckpoint> {
		const id = randomUUID();
		const createdAt = new Date().toISOString();

		const row = await this.prisma.forcedCheckpoint.create({
			data: {
				id,
				caller: input.caller,
				threadId: input.threadId,
				createdAt,
				sourceBoundary: input.sourceBoundary,
				summaryPayload: input.summaryPayload,
			},
		});
		return toForcedCheckpoint(row);
	}

	async readLatest(
		caller: string,
		threadId: string,
	): Promise<ForcedCheckpoint | null> {
		const row = await this.prisma.forcedCheckpoint.findFirst({
			where: { caller, threadId },
			orderBy: { createdAt: "desc" },
		});
		return row ? toForcedCheckpoint(row) : null;
	}

	async readLatestForCaller(caller: string): Promise<ForcedCheckpoint | null> {
		const row = await this.prisma.forcedCheckpoint.findFirst({
			where: { caller },
			orderBy: { createdAt: "desc" },
		});
		return row ? toForcedCheckpoint(row) : null;
	}

	async listForThread(
		caller: string,
		threadId: string,
	): Promise<ForcedCheckpoint[]> {
		const rows = await this.prisma.forcedCheckpoint.findMany({
			where: { caller, threadId },
			orderBy: { createdAt: "desc" },
		});
		return rows.map(toForcedCheckpoint);
	}
}
