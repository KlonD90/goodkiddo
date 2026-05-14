import { randomUUID } from "node:crypto";
import type { AppPrisma } from "../../db/prisma";

export type TimerKind = "always" | "once";

export interface TimerRecord {
	id: string;
	userId: string;
	chatId: string;
	mdFilePath: string;
	cronExpression: string;
	kind: TimerKind;
	message: string | null;
	timezone: string;
	enabled: boolean;
	lastRunAt: number | null;
	lastError: string | null;
	consecutiveFailures: number;
	nextRunAt: number;
	createdAt: number;
}

type TimerModel = {
	id: string;
	userId: string;
	chatId: string;
	mdFilePath: string;
	cronExpression: string;
	kind: string;
	message: string | null;
	timezone: string;
	enabled: number;
	lastRunAt: bigint | number | null;
	lastError: string | null;
	consecutiveFailures: number;
	nextRunAt: bigint | number;
	createdAt: bigint | number;
};

export interface TimerStoreOptions {
	prisma: AppPrisma;
	now?: () => number;
}

export interface CreateTimerParams {
	userId: string;
	chatId: string;
	mdFilePath?: string;
	cronExpression?: string;
	kind?: TimerKind;
	message?: string | null;
	timezone: string;
	nextRunAt: number;
}

export interface UpdateTimerParams {
	cronExpression?: string;
	timezone?: string;
	enabled?: boolean;
	nextRunAt?: number;
}

function toNumber(value: bigint | number | null): number | null {
	if (value === null) return null;
	return Number(value);
}

function modelToTimer(row: TimerModel): TimerRecord {
	return {
		id: row.id,
		userId: row.userId,
		chatId: row.chatId,
		mdFilePath: row.mdFilePath,
		cronExpression: row.cronExpression,
		kind: row.kind === "once" ? "once" : "always",
		message: row.message,
		timezone: row.timezone,
		enabled: row.enabled === 1,
		lastRunAt: toNumber(row.lastRunAt),
		lastError: row.lastError,
		consecutiveFailures: row.consecutiveFailures,
		nextRunAt: Number(row.nextRunAt),
		createdAt: Number(row.createdAt),
	};
}

export class TimerStore {
	private readonly prisma: AppPrisma;
	private readonly now: () => number;

	constructor(options: TimerStoreOptions) {
		this.prisma = options.prisma;
		this.now = options.now ?? (() => Date.now());
	}

	async ready(): Promise<void> {
		return;
	}

	async create(params: CreateTimerParams): Promise<TimerRecord> {
		const id = randomUUID();
		const now = this.now();
		return modelToTimer(
			await this.prisma.timer.create({
				data: {
					id,
					userId: params.userId,
					chatId: params.chatId,
					mdFilePath: params.mdFilePath ?? "",
					cronExpression: params.cronExpression ?? "",
					kind: params.kind ?? "always",
					message: params.message ?? null,
					timezone: params.timezone,
					enabled: 1,
					lastRunAt: null,
					lastError: null,
					consecutiveFailures: 0,
					nextRunAt: BigInt(params.nextRunAt),
					createdAt: BigInt(now),
				},
			}),
		);
	}

	async findDue(): Promise<TimerRecord[]> {
		const now = this.now();
		const rows = await this.prisma.timer.findMany({
			where: { enabled: 1, nextRunAt: { lte: BigInt(now) } },
			orderBy: { nextRunAt: "asc" },
		});
		return rows.map(modelToTimer);
	}

	async findByUser(userId: string): Promise<TimerRecord[]> {
		const rows = await this.prisma.timer.findMany({
			where: { userId },
			orderBy: { createdAt: "desc" },
		});
		return rows.map(modelToTimer);
	}

	async getById(id: string): Promise<TimerRecord | null> {
		const row = await this.prisma.timer.findUnique({ where: { id } });
		return row ? modelToTimer(row) : null;
	}

	async update(
		id: string,
		userId: string,
		updates: UpdateTimerParams,
	): Promise<TimerRecord | null> {
		const existing = await this.getById(id);
		if (!existing || existing.userId !== userId) {
			return null;
		}

		const cronExpression = updates.cronExpression ?? existing.cronExpression;
		const timezone = updates.timezone ?? existing.timezone;
		const enabled = updates.enabled ?? existing.enabled;
		const nextRunAt = updates.nextRunAt ?? existing.nextRunAt;

		const result = await this.prisma.timer.updateMany({
			where: { id, userId },
			data: {
				cronExpression,
				timezone,
				enabled: enabled ? 1 : 0,
				nextRunAt: BigInt(nextRunAt),
			},
		});
		if (result.count === 0) return null;
		const row = await this.prisma.timer.findFirst({ where: { id, userId } });
		return row ? modelToTimer(row) : null;
	}

	async delete(id: string, userId: string): Promise<boolean> {
		const result = await this.prisma.timer.deleteMany({
			where: { id, userId },
		});
		return result.count > 0;
	}

	async touchRun(id: string, nextRunAt: number): Promise<void> {
		const now = this.now();
		await this.prisma.timer.update({
			where: { id },
			data: {
				lastRunAt: BigInt(now),
				lastError: null,
				consecutiveFailures: 0,
				nextRunAt: BigInt(nextRunAt),
			},
		});
	}

	async touchError(
		id: string,
		userId: string,
		error: string,
		nextRunAt?: number,
	): Promise<number> {
		const result = await this.prisma.timer.updateMany({
			where: { id, userId },
			data: {
				lastError: error,
				consecutiveFailures: { increment: 1 },
				...(nextRunAt !== undefined ? { nextRunAt: BigInt(nextRunAt) } : {}),
			},
		});
		if (result.count === 0) return 0;
		const row = await this.prisma.timer.findFirst({ where: { id, userId } });
		return row?.consecutiveFailures ?? 0;
	}

	close(): void {
		// No-op: lifecycle is managed by the injected Prisma client.
	}
}
