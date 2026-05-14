import type { AppPrisma } from "../db/prisma";
import { compactInline } from "../utils/text";

export type TaskStatus = "active" | "completed" | "dismissed";

export interface TaskRecord {
	id: number;
	userId: string;
	threadIdCreated: string;
	threadIdCompleted: string | null;
	listName: string;
	title: string;
	note: string | null;
	status: TaskStatus;
	statusReason: string | null;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
	dismissedAt: number | null;
}

type TaskModel = {
	id: number;
	userId: string;
	threadIdCreated: string;
	threadIdCompleted: string | null;
	listName: string;
	title: string;
	note: string | null;
	status: string;
	statusReason: string | null;
	createdAt: bigint | number;
	updatedAt: bigint | number;
	completedAt: bigint | number | null;
	dismissedAt: bigint | number | null;
};

export interface TaskStoreOptions {
	prisma: AppPrisma;
	now?: () => number;
}

export interface AddTaskInput {
	userId: string;
	threadIdCreated: string;
	listName: string;
	title: string;
	note?: string | null;
}

export interface ActiveTaskSnapshotOptions {
	heading?: string;
	limit?: number;
	totalCount?: number;
}

export interface RecentCompletedTaskOptions {
	completedSince: number;
	limit?: number;
}

function requireCompactField(value: string, label: string): string {
	const compacted = compactInline(value);
	if (compacted === "") {
		throw new Error(`${label} cannot be empty.`);
	}
	return compacted;
}

function compactOptionalField(value?: string | null): string | null {
	if (value == null) return null;
	const compacted = compactInline(value);
	return compacted === "" ? null : compacted;
}

function toNumber(value: bigint | number | null): number | null {
	if (value === null) return null;
	return Number(value);
}

function modelToTask(row: TaskModel): TaskRecord {
	return {
		id: row.id,
		userId: row.userId,
		threadIdCreated: row.threadIdCreated,
		threadIdCompleted: row.threadIdCompleted,
		listName: row.listName,
		title: row.title,
		note: row.note,
		status: row.status as TaskStatus,
		statusReason: row.statusReason,
		createdAt: Number(row.createdAt),
		updatedAt: Number(row.updatedAt),
		completedAt: toNumber(row.completedAt),
		dismissedAt: toNumber(row.dismissedAt),
	};
}

export function formatActiveTaskSnapshot(
	tasks: TaskRecord[],
	options: ActiveTaskSnapshotOptions = {},
): string {
	const heading = options.heading ?? "## Active tasks";
	const limit = options.limit ?? tasks.length;
	const visibleTasks = tasks.slice(0, limit);
	const totalCount = options.totalCount ?? tasks.length;
	const lines = [heading];

	if (visibleTasks.length === 0) {
		lines.push("- None.");
		return lines.join("\n");
	}

	for (const task of visibleTasks) {
		const title = compactInline(task.title);
		const note = task.note ? ` — ${compactInline(task.note)}` : "";
		lines.push(`- [${task.id}] ${task.listName}: ${title}${note}`);
	}

	if (totalCount > visibleTasks.length) {
		lines.push(
			`- ... ${totalCount - visibleTasks.length} more active task(s).`,
		);
	}

	return lines.join("\n");
}

export class TaskStore {
	private readonly prisma: AppPrisma;
	private readonly now: () => number;

	constructor(options: TaskStoreOptions) {
		this.prisma = options.prisma;
		this.now = options.now ?? (() => Date.now());
	}

	async ready(): Promise<void> {
		return;
	}

	async addTask(input: AddTaskInput): Promise<TaskRecord> {
		const listName = requireCompactField(input.listName, "Task list name");
		const title = requireCompactField(input.title, "Task title");
		const note = compactOptionalField(input.note);
		const now = this.now();
		return modelToTask(
			await this.prisma.task.create({
				data: {
					userId: input.userId,
					threadIdCreated: input.threadIdCreated,
					threadIdCompleted: null,
					listName,
					title,
					note,
					status: "active",
					statusReason: null,
					createdAt: BigInt(now),
					updatedAt: BigInt(now),
					completedAt: null,
					dismissedAt: null,
				},
			}),
		);
	}

	async getTask(taskId: number, userId: string): Promise<TaskRecord | null> {
		const row = await this.prisma.task.findFirst({
			where: { id: taskId, userId },
		});
		return row ? modelToTask(row) : null;
	}

	async listTasksForUser(
		userId: string,
		options: {
			status?: TaskStatus;
			listName?: string;
			limit?: number;
		} = {},
	): Promise<TaskRecord[]> {
		const limit = options.limit ?? 100;
		const rows = await this.prisma.task.findMany({
			where: {
				userId,
				...(options.status ? { status: options.status } : {}),
				...(options.listName ? { listName: options.listName } : {}),
			},
			orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
			take: limit,
		});
		return rows.map(modelToTask);
	}

	async listActiveTasks(userId: string, limit = 100): Promise<TaskRecord[]> {
		return this.listTasksForUser(userId, { status: "active", limit });
	}

	async countTasksForUser(
		userId: string,
		options: {
			status?: TaskStatus;
			listName?: string;
		} = {},
	): Promise<number> {
		return this.prisma.task.count({
			where: {
				userId,
				...(options.status ? { status: options.status } : {}),
				...(options.listName ? { listName: options.listName } : {}),
			},
		});
	}

	async listRecentlyCompletedTasks(
		userId: string,
		options: RecentCompletedTaskOptions,
	): Promise<TaskRecord[]> {
		const limit = options.limit ?? 100;
		const rows = await this.prisma.task.findMany({
			where: {
				userId,
				status: "completed",
				completedAt: { gte: BigInt(options.completedSince) },
			},
			orderBy: [{ completedAt: "desc" }, { id: "desc" }],
			take: limit,
		});
		return rows.map(modelToTask);
	}

	async composeActiveTaskSnapshot(
		userId: string,
		options: ActiveTaskSnapshotOptions = {},
	): Promise<string> {
		const limit = options.limit ?? 12;
		const [tasks, totalCount] = await Promise.all([
			this.listActiveTasks(userId, limit),
			this.countTasksForUser(userId, { status: "active" }),
		]);
		return formatActiveTaskSnapshot(tasks, {
			...options,
			limit,
			totalCount,
		});
	}

	async completeTask(params: {
		taskId: number;
		userId: string;
		threadIdCompleted: string;
	}): Promise<TaskRecord | null> {
		const now = this.now();
		const result = await this.prisma.task.updateMany({
			where: { id: params.taskId, userId: params.userId, status: "active" },
			data: {
				status: "completed",
				threadIdCompleted: params.threadIdCompleted,
				statusReason: null,
				updatedAt: BigInt(now),
				completedAt: BigInt(now),
				dismissedAt: null,
			},
		});
		if (result.count === 0) return null;
		const task = await this.prisma.task.findUnique({
			where: { id: params.taskId },
		});
		if (!task) return null;
		return modelToTask(task);
	}

	async dismissTask(params: {
		taskId: number;
		userId: string;
		reason?: string | null;
	}): Promise<TaskRecord | null> {
		const reason = compactOptionalField(params.reason);
		const now = this.now();
		const result = await this.prisma.task.updateMany({
			where: { id: params.taskId, userId: params.userId, status: "active" },
			data: {
				status: "dismissed",
				statusReason: reason,
				updatedAt: BigInt(now),
				completedAt: null,
				dismissedAt: BigInt(now),
			},
		});
		if (result.count === 0) return null;
		const task = await this.prisma.task.findUnique({
			where: { id: params.taskId },
		});
		if (!task) return null;
		return modelToTask(task);
	}

	close(): void {
		// No-op: lifecycle is managed by the injected Prisma client.
	}
}
