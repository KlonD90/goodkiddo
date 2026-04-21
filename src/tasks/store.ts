import { compactInline } from "../utils/text";

type SQL = InstanceType<typeof Bun.SQL>;

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

type TaskRow = {
	id: number;
	user_id: string;
	thread_id_created: string;
	thread_id_completed: string | null;
	list_name: string;
	title: string;
	note: string | null;
	status: string;
	status_reason: string | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
	dismissed_at: number | null;
};

export interface TaskStoreOptions {
	db: SQL;
	dialect: "sqlite" | "postgres";
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

function rowToTask(row: TaskRow): TaskRecord {
	return {
		id: row.id,
		userId: row.user_id,
		threadIdCreated: row.thread_id_created,
		threadIdCompleted: row.thread_id_completed,
		listName: row.list_name,
		title: row.title,
		note: row.note,
		status: row.status as TaskStatus,
		statusReason: row.status_reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
		dismissedAt: row.dismissed_at,
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
		lines.push(`- ... ${totalCount - visibleTasks.length} more active task(s).`);
	}

	return lines.join("\n");
}

export class TaskStore {
	private readonly db: SQL;
	private readonly dialect: "sqlite" | "postgres";
	private readonly now: () => number;
	private readonly _ready: Promise<void>;

	constructor(options: TaskStoreOptions) {
		this.db = options.db;
		this.dialect = options.dialect;
		this.now = options.now ?? (() => Date.now());
		this._ready = this.init();
		this._ready.catch(() => {});
	}

	private async init(): Promise<void> {
		if (this.dialect === "postgres") {
			await this.db`
				CREATE TABLE IF NOT EXISTS tasks (
					id SERIAL PRIMARY KEY,
					user_id TEXT NOT NULL,
					thread_id_created TEXT NOT NULL,
					thread_id_completed TEXT,
					list_name TEXT NOT NULL,
					title TEXT NOT NULL,
					note TEXT,
					status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'dismissed')),
					status_reason TEXT,
					created_at BIGINT NOT NULL,
					updated_at BIGINT NOT NULL,
					completed_at BIGINT,
					dismissed_at BIGINT
				)
			`;
		} else {
			await this.db`
				CREATE TABLE IF NOT EXISTS tasks (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					user_id TEXT NOT NULL,
					thread_id_created TEXT NOT NULL,
					thread_id_completed TEXT,
					list_name TEXT NOT NULL,
					title TEXT NOT NULL,
					note TEXT,
					status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'dismissed')),
					status_reason TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					completed_at INTEGER,
					dismissed_at INTEGER
				)
			`;
		}

		await this.db`
			CREATE INDEX IF NOT EXISTS idx_tasks_user_status_updated_at
			ON tasks(user_id, status, updated_at DESC)
		`;
		await this.db`
			CREATE INDEX IF NOT EXISTS idx_tasks_user_list_status
			ON tasks(user_id, list_name, status)
		`;

		if (this.dialect === "sqlite") {
			await this.db`PRAGMA journal_mode = WAL`;
		}
	}

	async ready(): Promise<void> {
		await this._ready;
	}

	async addTask(input: AddTaskInput): Promise<TaskRecord> {
		await this._ready;
		const listName = requireCompactField(input.listName, "Task list name");
		const title = requireCompactField(input.title, "Task title");
		const note = compactOptionalField(input.note);
		const now = this.now();
		const rows = await this.db<TaskRow[]>`
			INSERT INTO tasks (
				user_id,
				thread_id_created,
				thread_id_completed,
				list_name,
				title,
				note,
				status,
				status_reason,
				created_at,
				updated_at,
				completed_at,
				dismissed_at
			) VALUES (
				${input.userId},
				${input.threadIdCreated},
				NULL,
				${listName},
				${title},
				${note},
				'active',
				NULL,
				${now},
				${now},
				NULL,
				NULL
			)
			RETURNING
				id,
				user_id,
				thread_id_created,
				thread_id_completed,
				list_name,
				title,
				note,
				status,
				status_reason,
				created_at,
				updated_at,
				completed_at,
				dismissed_at
		`;
		const row = rows[0];
		if (!row) throw new Error("Failed to add task");
		return rowToTask(row);
	}

	async getTask(taskId: number, userId: string): Promise<TaskRecord | null> {
		await this._ready;
		const rows = await this.db<TaskRow[]>`
			SELECT
				id,
				user_id,
				thread_id_created,
				thread_id_completed,
				list_name,
				title,
				note,
				status,
				status_reason,
				created_at,
				updated_at,
				completed_at,
				dismissed_at
			FROM tasks
			WHERE id = ${taskId} AND user_id = ${userId}
			LIMIT 1
		`;
		return rows[0] ? rowToTask(rows[0]) : null;
	}

	async listTasksForUser(
		userId: string,
		options: {
			status?: TaskStatus;
			listName?: string;
			limit?: number;
		} = {},
	): Promise<TaskRecord[]> {
		await this._ready;
		const limit = options.limit ?? 100;
		if (options.status && options.listName) {
			const rows = await this.db<TaskRow[]>`
				SELECT
					id,
					user_id,
					thread_id_created,
					thread_id_completed,
					list_name,
					title,
					note,
					status,
					status_reason,
					created_at,
					updated_at,
					completed_at,
					dismissed_at
				FROM tasks
				WHERE user_id = ${userId}
					AND status = ${options.status}
					AND list_name = ${options.listName}
				ORDER BY updated_at DESC, id DESC
				LIMIT ${limit}
			`;
			return rows.map(rowToTask);
		}
		if (options.status) {
			const rows = await this.db<TaskRow[]>`
				SELECT
					id,
					user_id,
					thread_id_created,
					thread_id_completed,
					list_name,
					title,
					note,
					status,
					status_reason,
					created_at,
					updated_at,
					completed_at,
					dismissed_at
				FROM tasks
				WHERE user_id = ${userId}
					AND status = ${options.status}
				ORDER BY updated_at DESC, id DESC
				LIMIT ${limit}
			`;
			return rows.map(rowToTask);
		}
		if (options.listName) {
			const rows = await this.db<TaskRow[]>`
				SELECT
					id,
					user_id,
					thread_id_created,
					thread_id_completed,
					list_name,
					title,
					note,
					status,
					status_reason,
					created_at,
					updated_at,
					completed_at,
					dismissed_at
				FROM tasks
				WHERE user_id = ${userId}
					AND list_name = ${options.listName}
				ORDER BY updated_at DESC, id DESC
				LIMIT ${limit}
			`;
			return rows.map(rowToTask);
		}
		const rows = await this.db<TaskRow[]>`
			SELECT
				id,
				user_id,
				thread_id_created,
				thread_id_completed,
				list_name,
				title,
				note,
				status,
				status_reason,
				created_at,
				updated_at,
				completed_at,
				dismissed_at
			FROM tasks
			WHERE user_id = ${userId}
			ORDER BY updated_at DESC, id DESC
			LIMIT ${limit}
		`;
		return rows.map(rowToTask);
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
		await this._ready;
		if (options.status && options.listName) {
			const rows = await this.db<Array<{ count: number | bigint }>>`
				SELECT COUNT(*) AS count
				FROM tasks
				WHERE user_id = ${userId}
					AND status = ${options.status}
					AND list_name = ${options.listName}
			`;
			return Number(rows[0]?.count ?? 0);
		}
		if (options.status) {
			const rows = await this.db<Array<{ count: number | bigint }>>`
				SELECT COUNT(*) AS count
				FROM tasks
				WHERE user_id = ${userId}
					AND status = ${options.status}
			`;
			return Number(rows[0]?.count ?? 0);
		}
		if (options.listName) {
			const rows = await this.db<Array<{ count: number | bigint }>>`
				SELECT COUNT(*) AS count
				FROM tasks
				WHERE user_id = ${userId}
					AND list_name = ${options.listName}
			`;
			return Number(rows[0]?.count ?? 0);
		}
		const rows = await this.db<Array<{ count: number | bigint }>>`
			SELECT COUNT(*) AS count
			FROM tasks
			WHERE user_id = ${userId}
		`;
		return Number(rows[0]?.count ?? 0);
	}

	async listRecentlyCompletedTasks(
		userId: string,
		options: RecentCompletedTaskOptions,
	): Promise<TaskRecord[]> {
		await this._ready;
		const limit = options.limit ?? 100;
		const rows = await this.db<TaskRow[]>`
			SELECT
				id,
				user_id,
				thread_id_created,
				thread_id_completed,
				list_name,
				title,
				note,
				status,
				status_reason,
				created_at,
				updated_at,
				completed_at,
				dismissed_at
			FROM tasks
			WHERE user_id = ${userId}
				AND status = 'completed'
				AND completed_at IS NOT NULL
				AND completed_at >= ${options.completedSince}
			ORDER BY completed_at DESC, id DESC
			LIMIT ${limit}
		`;
		return rows.map(rowToTask);
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
		await this._ready;
		const now = this.now();
		const rows = await this.db<TaskRow[]>`
			UPDATE tasks
			SET
				status = 'completed',
				thread_id_completed = ${params.threadIdCompleted},
				status_reason = NULL,
				updated_at = ${now},
				completed_at = ${now},
				dismissed_at = NULL
			WHERE id = ${params.taskId}
				AND user_id = ${params.userId}
				AND status = 'active'
			RETURNING
				id,
				user_id,
				thread_id_created,
				thread_id_completed,
				list_name,
				title,
				note,
				status,
				status_reason,
				created_at,
				updated_at,
				completed_at,
				dismissed_at
		`;
		return rows[0] ? rowToTask(rows[0]) : null;
	}

	async dismissTask(params: {
		taskId: number;
		userId: string;
		reason?: string | null;
	}): Promise<TaskRecord | null> {
		await this._ready;
		const reason = compactOptionalField(params.reason);
		const now = this.now();
		const rows = await this.db<TaskRow[]>`
			UPDATE tasks
			SET
				status = 'dismissed',
				status_reason = ${reason},
				updated_at = ${now},
				completed_at = NULL,
				dismissed_at = ${now}
			WHERE id = ${params.taskId}
				AND user_id = ${params.userId}
				AND status = 'active'
			RETURNING
				id,
				user_id,
				thread_id_created,
				thread_id_completed,
				list_name,
				title,
				note,
				status,
				status_reason,
				created_at,
				updated_at,
				completed_at,
				dismissed_at
		`;
		return rows[0] ? rowToTask(rows[0]) : null;
	}

	close(): void {
		// No-op: lifecycle is managed by the injected db connection.
	}
}
