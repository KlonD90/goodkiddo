import { createLogger } from "../logger";
import { compactInline } from "../utils/text";

const log = createLogger("tasks.store");

type SQL = InstanceType<typeof Bun.SQL>;

export type TaskStatus = "active" | "completed" | "dismissed";
export type TaskLoopType =
	| "deadline"
	| "client_followup"
	| "decision"
	| "watch"
	| "continuation"
	| "general";

const TASK_LOOP_TYPES = new Set<TaskLoopType>([
	"deadline",
	"client_followup",
	"decision",
	"watch",
	"continuation",
	"general",
]);

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
	dueAt: number | null;
	nextCheckAt: number | null;
	priority: number;
	loopType: TaskLoopType | null;
	sourceContext: string | null;
	sourceRef: string | null;
	lastNudgedAt: number | null;
	nudgeCount: number;
	snoozedUntil: number | null;
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
	due_at: number | null;
	next_check_at: number | null;
	priority: number;
	loop_type: string | null;
	source_context: string | null;
	source_ref: string | null;
	last_nudged_at: number | null;
	nudge_count: number;
	snoozed_until: number | null;
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
	dueAt?: number | null;
	nextCheckAt?: number | null;
	priority?: number;
	loopType?: TaskLoopType | null;
	sourceContext?: string | null;
	sourceRef?: string | null;
	lastNudgedAt?: number | null;
	nudgeCount?: number;
	snoozedUntil?: number | null;
}

export interface UpdateTaskMetadataInput {
	taskId: number;
	userId: string;
	dueAt?: number | null;
	nextCheckAt?: number | null;
	priority?: number;
	loopType?: TaskLoopType | null;
	sourceContext?: string | null;
	sourceRef?: string | null;
	lastNudgedAt?: number | null;
	nudgeCount?: number;
	snoozedUntil?: number | null;
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

function normalizeOptionalTimestamp(
	value: number | null | undefined,
	label: string,
): number | null | undefined {
	if (value === undefined || value === null) return value;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer timestamp.`);
	}
	return value;
}

function normalizePriority(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 0 || value > 3) {
		throw new Error("Task priority must be an integer from 0 to 3.");
	}
	return value;
}

function normalizeLoopType(
	value: TaskLoopType | null | undefined,
): TaskLoopType | null | undefined {
	if (value === undefined || value === null) return value;
	if (!TASK_LOOP_TYPES.has(value)) {
		throw new Error("Task loop type is not supported.");
	}
	return value;
}

function normalizeNudgeCount(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error("Task nudge count must be a non-negative integer.");
	}
	return value;
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
		dueAt: row.due_at,
		nextCheckAt: row.next_check_at,
		priority: row.priority,
		loopType: row.loop_type as TaskLoopType | null,
		sourceContext: row.source_context,
		sourceRef: row.source_ref,
		lastNudgedAt: row.last_nudged_at,
		nudgeCount: row.nudge_count,
		snoozedUntil: row.snoozed_until,
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
	private readonly db: SQL;
	private readonly dialect: "sqlite" | "postgres";
	private readonly now: () => number;
	private readonly _ready: Promise<void>;

	constructor(options: TaskStoreOptions) {
		this.db = options.db;
		this.dialect = options.dialect;
		this.now = options.now ?? (() => Date.now());
		this._ready = this.init();
		this._ready.catch((err) => {
			log.error("initialization failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
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
					dismissed_at BIGINT,
					due_at BIGINT,
					next_check_at BIGINT,
					priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3),
					loop_type TEXT CHECK(loop_type IS NULL OR loop_type IN ('deadline', 'client_followup', 'decision', 'watch', 'continuation', 'general')),
					source_context TEXT,
					source_ref TEXT,
					last_nudged_at BIGINT,
					nudge_count INTEGER NOT NULL DEFAULT 0 CHECK(nudge_count >= 0),
					snoozed_until BIGINT
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
					dismissed_at INTEGER,
					due_at INTEGER,
					next_check_at INTEGER,
					priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3),
					loop_type TEXT CHECK(loop_type IS NULL OR loop_type IN ('deadline', 'client_followup', 'decision', 'watch', 'continuation', 'general')),
					source_context TEXT,
					source_ref TEXT,
					last_nudged_at INTEGER,
					nudge_count INTEGER NOT NULL DEFAULT 0 CHECK(nudge_count >= 0),
					snoozed_until INTEGER
				)
			`;
		}

		await this.migrateTaskMetadataColumns();

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

	private async migrateTaskMetadataColumns(): Promise<void> {
		if (this.dialect === "postgres") {
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN IF NOT EXISTS due_at BIGINT
			`;
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN IF NOT EXISTS next_check_at BIGINT
			`;
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3)
			`;
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN IF NOT EXISTS loop_type TEXT CHECK(loop_type IS NULL OR loop_type IN ('deadline', 'client_followup', 'decision', 'watch', 'continuation', 'general'))
			`;
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN IF NOT EXISTS source_context TEXT
			`;
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN IF NOT EXISTS source_ref TEXT
			`;
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN IF NOT EXISTS last_nudged_at BIGINT
			`;
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN IF NOT EXISTS nudge_count INTEGER NOT NULL DEFAULT 0 CHECK(nudge_count >= 0)
			`;
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN IF NOT EXISTS snoozed_until BIGINT
			`;
			return;
		}

		const columns = await this.db<
			Array<{ name: string }>
		>`PRAGMA table_info(tasks)`;
		const columnNames = new Set(columns.map((column) => column.name));
		if (!columnNames.has("due_at")) {
			await this.db`ALTER TABLE tasks ADD COLUMN due_at INTEGER`;
		}
		if (!columnNames.has("next_check_at")) {
			await this.db`ALTER TABLE tasks ADD COLUMN next_check_at INTEGER`;
		}
		if (!columnNames.has("priority")) {
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3)
			`;
		}
		if (!columnNames.has("loop_type")) {
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN loop_type TEXT CHECK(loop_type IS NULL OR loop_type IN ('deadline', 'client_followup', 'decision', 'watch', 'continuation', 'general'))
			`;
		}
		if (!columnNames.has("source_context")) {
			await this.db`ALTER TABLE tasks ADD COLUMN source_context TEXT`;
		}
		if (!columnNames.has("source_ref")) {
			await this.db`ALTER TABLE tasks ADD COLUMN source_ref TEXT`;
		}
		if (!columnNames.has("last_nudged_at")) {
			await this.db`ALTER TABLE tasks ADD COLUMN last_nudged_at INTEGER`;
		}
		if (!columnNames.has("nudge_count")) {
			await this.db`
				ALTER TABLE tasks
				ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0 CHECK(nudge_count >= 0)
			`;
		}
		if (!columnNames.has("snoozed_until")) {
			await this.db`ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER`;
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
		const dueAt =
			normalizeOptionalTimestamp(input.dueAt, "Task due time") ?? null;
		const nextCheckAt =
			normalizeOptionalTimestamp(input.nextCheckAt, "Task next check time") ??
			null;
		const priority = normalizePriority(input.priority) ?? 0;
		const loopType = normalizeLoopType(input.loopType) ?? null;
		const sourceContext = compactOptionalField(input.sourceContext);
		const sourceRef = compactOptionalField(input.sourceRef);
		const lastNudgedAt =
			normalizeOptionalTimestamp(input.lastNudgedAt, "Task last nudged time") ??
			null;
		const nudgeCount = normalizeNudgeCount(input.nudgeCount) ?? 0;
		const snoozedUntil =
			normalizeOptionalTimestamp(
				input.snoozedUntil,
				"Task snoozed until time",
			) ?? null;
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
				dismissed_at,
				due_at,
				next_check_at,
				priority,
				loop_type,
				source_context,
				source_ref,
				last_nudged_at,
				nudge_count,
				snoozed_until
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
				NULL,
				${dueAt},
				${nextCheckAt},
				${priority},
				${loopType},
				${sourceContext},
				${sourceRef},
				${lastNudgedAt},
				${nudgeCount},
				${snoozedUntil}
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
				dismissed_at,
				due_at,
				next_check_at,
				priority,
				loop_type,
				source_context,
				source_ref,
				last_nudged_at,
				nudge_count,
				snoozed_until
		`;
		const row = rows[0];
		if (!row) throw new Error("Failed to add task");
		return rowToTask(row);
	}

	async updateTaskMetadata(
		input: UpdateTaskMetadataInput,
	): Promise<TaskRecord | null> {
		await this._ready;
		const shouldUpdateDueAt = input.dueAt !== undefined;
		const shouldUpdateNextCheckAt = input.nextCheckAt !== undefined;
		const shouldUpdatePriority = input.priority !== undefined;
		const shouldUpdateLoopType = input.loopType !== undefined;
		const shouldUpdateSourceContext = input.sourceContext !== undefined;
		const shouldUpdateSourceRef = input.sourceRef !== undefined;
		const shouldUpdateLastNudgedAt = input.lastNudgedAt !== undefined;
		const shouldUpdateNudgeCount = input.nudgeCount !== undefined;
		const shouldUpdateSnoozedUntil = input.snoozedUntil !== undefined;

		const hasUpdates = [
			shouldUpdateDueAt,
			shouldUpdateNextCheckAt,
			shouldUpdatePriority,
			shouldUpdateLoopType,
			shouldUpdateSourceContext,
			shouldUpdateSourceRef,
			shouldUpdateLastNudgedAt,
			shouldUpdateNudgeCount,
			shouldUpdateSnoozedUntil,
		].some(Boolean);
		if (!hasUpdates) return this.getTask(input.taskId, input.userId);

		const dueAt = shouldUpdateDueAt
			? (normalizeOptionalTimestamp(input.dueAt, "Task due time") ?? null)
			: null;
		const nextCheckAt = shouldUpdateNextCheckAt
			? (normalizeOptionalTimestamp(
					input.nextCheckAt,
					"Task next check time",
				) ?? null)
			: null;
		const priority = shouldUpdatePriority
			? (normalizePriority(input.priority) ?? 0)
			: 0;
		const loopType = shouldUpdateLoopType
			? (normalizeLoopType(input.loopType) ?? null)
			: null;
		const sourceContext = shouldUpdateSourceContext
			? compactOptionalField(input.sourceContext)
			: null;
		const sourceRef = shouldUpdateSourceRef
			? compactOptionalField(input.sourceRef)
			: null;
		const lastNudgedAt = shouldUpdateLastNudgedAt
			? (normalizeOptionalTimestamp(
					input.lastNudgedAt,
					"Task last nudged time",
				) ?? null)
			: null;
		const nudgeCount = shouldUpdateNudgeCount
			? (normalizeNudgeCount(input.nudgeCount) ?? 0)
			: 0;
		const snoozedUntil = shouldUpdateSnoozedUntil
			? (normalizeOptionalTimestamp(
					input.snoozedUntil,
					"Task snoozed until time",
				) ?? null)
			: null;
		const now = this.now();
		const rows = await this.db<TaskRow[]>`
			UPDATE tasks
			SET
				due_at = CASE WHEN ${shouldUpdateDueAt} THEN ${dueAt} ELSE due_at END,
				next_check_at = CASE WHEN ${shouldUpdateNextCheckAt} THEN ${nextCheckAt} ELSE next_check_at END,
				priority = CASE WHEN ${shouldUpdatePriority} THEN ${priority} ELSE priority END,
				loop_type = CASE WHEN ${shouldUpdateLoopType} THEN ${loopType} ELSE loop_type END,
				source_context = CASE WHEN ${shouldUpdateSourceContext} THEN ${sourceContext} ELSE source_context END,
				source_ref = CASE WHEN ${shouldUpdateSourceRef} THEN ${sourceRef} ELSE source_ref END,
				last_nudged_at = CASE WHEN ${shouldUpdateLastNudgedAt} THEN ${lastNudgedAt} ELSE last_nudged_at END,
				nudge_count = CASE WHEN ${shouldUpdateNudgeCount} THEN ${nudgeCount} ELSE nudge_count END,
				snoozed_until = CASE WHEN ${shouldUpdateSnoozedUntil} THEN ${snoozedUntil} ELSE snoozed_until END,
				updated_at = ${now}
			WHERE id = ${input.taskId}
				AND user_id = ${input.userId}
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
				dismissed_at,
				due_at,
				next_check_at,
				priority,
				loop_type,
				source_context,
				source_ref,
				last_nudged_at,
				nudge_count,
				snoozed_until
		`;
		return rows[0] ? rowToTask(rows[0]) : null;
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
				dismissed_at,
				due_at,
				next_check_at,
				priority,
				loop_type,
				source_context,
				source_ref,
				last_nudged_at,
				nudge_count,
				snoozed_until
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
					dismissed_at,
					due_at,
					next_check_at,
					priority,
					loop_type,
					source_context,
					source_ref,
					last_nudged_at,
					nudge_count,
					snoozed_until
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
					dismissed_at,
					due_at,
					next_check_at,
					priority,
					loop_type,
					source_context,
					source_ref,
					last_nudged_at,
					nudge_count,
					snoozed_until
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
					dismissed_at,
					due_at,
					next_check_at,
					priority,
					loop_type,
					source_context,
					source_ref,
					last_nudged_at,
					nudge_count,
					snoozed_until
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
				dismissed_at,
				due_at,
				next_check_at,
				priority,
				loop_type,
				source_context,
				source_ref,
				last_nudged_at,
				nudge_count,
				snoozed_until
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
				dismissed_at,
				due_at,
				next_check_at,
				priority,
				loop_type,
				source_context,
				source_ref,
				last_nudged_at,
				nudge_count,
				snoozed_until
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
				dismissed_at,
				due_at,
				next_check_at,
				priority,
				loop_type,
				source_context,
				source_ref,
				last_nudged_at,
				nudge_count,
				snoozed_until
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
				dismissed_at,
				due_at,
				next_check_at,
				priority,
				loop_type,
				source_context,
				source_ref,
				last_nudged_at,
				nudge_count,
				snoozed_until
		`;
		return rows[0] ? rowToTask(rows[0]) : null;
	}

	close(): void {
		// No-op: lifecycle is managed by the injected db connection.
	}
}
