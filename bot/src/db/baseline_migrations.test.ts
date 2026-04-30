import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../tasks/store";
import { buildDbmateConfig } from "./migrate";

type TableInfoRow = {
	dflt_value: string | null;
	name: string;
	notnull: number;
};

type TableListRow = {
	name: string;
};

type PostgresColumnRow = {
	column_default: string | null;
	column_name: string;
	is_nullable: "YES" | "NO";
};

const tempDirs: string[] = [];
const postgresDatabaseUrl = process.env.GOODKIDDO_TEST_POSTGRES_URL;
const postgresIntegrationTest = postgresDatabaseUrl ? test : test.skip;

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

const runDbmate = async (
	databaseUrl: string,
	command: "up" | "rollback",
): Promise<void> => {
	const config = buildDbmateConfig(databaseUrl);
	const proc = Bun.spawn(
		[
			"bun",
			join(process.cwd(), "node_modules", "dbmate", "dist", "cli.js"),
			"--url",
			config.databaseUrl,
			"--migrations-dir",
			config.migrationsDir,
			"--no-dump-schema",
			command,
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
};

const runSqliteDbmate = async (
	databasePath: string,
	command: "up" | "rollback",
): Promise<void> => runDbmate(`sqlite:${databasePath}`, command);

const runSqliteMigrations = async (databasePath: string): Promise<void> =>
	runSqliteDbmate(databasePath, "up");

const withPostgresSearchPath = (
	databaseUrl: string,
	schema: string,
): string => {
	const url = new URL(databaseUrl);
	const existingOptions = url.searchParams.get("options");
	const searchPathOption = `-c search_path=${schema}`;
	url.searchParams.set(
		"options",
		existingOptions
			? `${existingOptions} ${searchPathOption}`
			: searchPathOption,
	);
	return url.toString();
};

describe("baseline migrations", () => {
	test("sqlite migrations create current task baseline schema", async () => {
		const dir = await createTempDir();
		const databasePath = join(dir, "state.db");
		await runSqliteMigrations(databasePath);

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
			expect(tables.map((table) => table.name)).not.toContain("timers");

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
		} finally {
			await db.close();
		}
	});

	postgresIntegrationTest(
		"postgres migrations create and roll back current task baseline schema",
		async () => {
			if (!postgresDatabaseUrl) {
				throw new Error("GOODKIDDO_TEST_POSTGRES_URL is required");
			}

			const schema = `goodkiddo_migrations_${randomUUID().replaceAll("-", "")}`;
			const adminDb = new Bun.SQL(postgresDatabaseUrl);
			await adminDb.unsafe(`CREATE SCHEMA ${schema}`);
			await adminDb.close();

			const databaseUrl = withPostgresSearchPath(postgresDatabaseUrl, schema);
			try {
				await runDbmate(databaseUrl, "up");

				const db = new Bun.SQL(databaseUrl);
				try {
					const taskColumns = await db<PostgresColumnRow[]>`
						SELECT column_name, column_default, is_nullable
						FROM information_schema.columns
						WHERE table_schema = ${schema}
							AND table_name = 'tasks'
						ORDER BY ordinal_position
					`;
					expect(taskColumns.map((column) => column.column_name)).toEqual([
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
							.filter((column) =>
								["priority", "nudge_count"].includes(column.column_name),
							)
							.map((column) => ({
								defaultValue: column.column_default,
								name: column.column_name,
								nullable: column.is_nullable,
							})),
					).toEqual([
						{ defaultValue: "0", name: "priority", nullable: "NO" },
						{ defaultValue: "0", name: "nudge_count", nullable: "NO" },
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
				} finally {
					await db.close();
				}

				await runDbmate(databaseUrl, "rollback");

				const rolledBackDb = new Bun.SQL(databaseUrl);
				try {
					const taskColumns = await rolledBackDb<PostgresColumnRow[]>`
						SELECT column_name, column_default, is_nullable
						FROM information_schema.columns
						WHERE table_schema = ${schema}
							AND table_name = 'tasks'
						ORDER BY ordinal_position
					`;
					expect(taskColumns.map((column) => column.column_name)).toEqual([
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
					]);
				} finally {
					await rolledBackDb.close();
				}
			} finally {
				const cleanupDb = new Bun.SQL(postgresDatabaseUrl);
				try {
					await cleanupDb.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
				} finally {
					await cleanupDb.close();
				}
			}
		},
	);

	test("task store remains compatible with the migrated task schema", async () => {
		const dir = await createTempDir();
		const databasePath = join(dir, "state.db");
		await runSqliteMigrations(databasePath);

		const db = new Bun.SQL(`sqlite:${databasePath}`);
		try {
			let now = 10_000;
			const store = new TaskStore({
				db,
				dialect: "sqlite",
				now: () => now++,
			});
			await store.ready();

			const task = await store.addTask({
				userId: "telegram:1",
				threadIdCreated: "thread-a",
				listName: "today",
				title: "Use migrated task table",
				note: "metadata columns exist",
			});
			expect(task.status).toBe("active");
			expect(task.note).toBe("metadata columns exist");

			const activeTasks = await store.listActiveTasks("telegram:1");
			expect(activeTasks.map((item) => item.id)).toEqual([task.id]);

			const metadataRows = await db<
				{ due_at: number | null; nudge_count: number; priority: number }[]
			>`
				SELECT due_at, priority, nudge_count
				FROM tasks
				WHERE id = ${task.id}
			`;
			expect(metadataRows).toEqual([
				{ due_at: null, nudge_count: 0, priority: 0 },
			]);

			const completed = await store.completeTask({
				taskId: task.id,
				userId: "telegram:1",
				threadIdCompleted: "thread-done",
			});
			expect(completed?.status).toBe("completed");
			expect(await store.listActiveTasks("telegram:1")).toEqual([]);
		} finally {
			await db.close();
		}
	});

	test("sqlite rollback reverts the latest task metadata migration", async () => {
		const dir = await createTempDir();
		const databasePath = join(dir, "state.db");
		await runSqliteMigrations(databasePath);
		await runSqliteDbmate(databasePath, "rollback");

		const db = new Bun.SQL(`sqlite:${databasePath}`);
		try {
			const tables = await db<TableListRow[]>`
				SELECT name
				FROM sqlite_master
				WHERE type = 'table'
				ORDER BY name
			`;
			expect(tables.map((table) => table.name)).toContain("tasks");
			expect(tables.map((table) => table.name)).not.toContain("timers");

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
			]);
		} finally {
			await db.close();
		}
	});
});
