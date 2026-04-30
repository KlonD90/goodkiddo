import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDbmateConfig } from "./migrate";

type TableInfoRow = {
	dflt_value: string | null;
	name: string;
	notnull: number;
};

type TableListRow = {
	name: string;
};

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

const createTempDir = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "goodkiddo-migrations-"));
	tempDirs.push(dir);
	return dir;
};

describe("baseline migrations", () => {
	test("sqlite migrations create current task and timer baseline schemas", async () => {
		const dir = await createTempDir();
		const databasePath = join(dir, "state.db");
		const config = buildDbmateConfig(`sqlite:${databasePath}`);
		const proc = Bun.spawn(
			[
				"bunx",
				"--bun",
				"dbmate",
				"--url",
				config.databaseUrl,
				"--migrations-dir",
				config.migrationsDir,
				"up",
			],
			{
				stderr: "pipe",
				stdout: "pipe",
			},
		);

		const [exitCode, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stderr).text(),
		]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);

		const db = new Bun.SQL(`sqlite:${databasePath}`);
		try {
			const tables = await db<TableListRow[]>`
				SELECT name
				FROM sqlite_master
				WHERE type = 'table'
				ORDER BY name
			`;
			expect(tables.map((table) => table.name)).toContain("schema_migrations");
			expect(tables.map((table) => table.name)).toContain("tasks");
			expect(tables.map((table) => table.name)).toContain("timers");

			const taskColumns = await db<TableInfoRow[]>`PRAGMA table_info(tasks)`;
			expect(taskColumns.map((column) => column.name)).toEqual([
				"id",
				"user_id",
				"thread_id_created",
				"thread_id_completed",
				"list_name",
				"title",
				"note",
				"status",
				"status_reason",
				"created_at",
				"updated_at",
				"completed_at",
				"dismissed_at",
				"due_at",
				"next_check_at",
				"priority",
				"loop_type",
				"source_context",
				"source_ref",
				"last_nudged_at",
				"nudge_count",
				"snoozed_until",
			]);
			expect(
				taskColumns
					.filter((column) => ["priority", "nudge_count"].includes(column.name))
					.map((column) => ({
						defaultValue: column.dflt_value,
						name: column.name,
						notNull: column.notnull,
					})),
			).toEqual([
				{ defaultValue: "0", name: "priority", notNull: 1 },
				{ defaultValue: "0", name: "nudge_count", notNull: 1 },
			]);

			const insertedRows = await db<
				{
					due_at: number | null;
					nudge_count: number;
					priority: number;
					source_context: string | null;
				}[]
			>`
				INSERT INTO tasks (
					user_id,
					thread_id_created,
					list_name,
					title,
					status,
					created_at,
					updated_at
				) VALUES (
					'user-1',
					'thread-1',
					'default',
					'Old row shape',
					'active',
					1,
					1
				)
				RETURNING due_at, priority, source_context, nudge_count
			`;
			expect(insertedRows).toEqual([
				{
					due_at: null,
					nudge_count: 0,
					priority: 0,
					source_context: null,
				},
			]);

			const timerColumns = await db<TableInfoRow[]>`PRAGMA table_info(timers)`;
			expect(timerColumns.map((column) => column.name)).toEqual([
				"id",
				"user_id",
				"chat_id",
				"md_file_path",
				"cron_expression",
				"kind",
				"message",
				"timezone",
				"enabled",
				"last_run_at",
				"last_error",
				"consecutive_failures",
				"next_run_at",
				"created_at",
			]);
		} finally {
			await db.close();
		}
	});
});
