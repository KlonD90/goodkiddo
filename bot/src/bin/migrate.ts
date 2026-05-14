import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { DEFAULT_DATABASE_URL } from "../config";

type Migration = {
	name: string;
	checksum: string;
	sql: string;
};

const BASELINE_MIGRATION = "20260514000000_initial_prisma_schema";
const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);

function loadMigrations(): Migration[] {
	return readdirSync(migrationsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const sql = readFileSync(
				new URL(`${entry.name}/migration.sql`, migrationsDir),
				"utf8",
			);
			return {
				name: entry.name,
				checksum: createHash("sha256").update(sql).digest("hex"),
				sql,
			};
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
	await client.query(`
		CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
			"id" VARCHAR(36) PRIMARY KEY NOT NULL,
			"checksum" VARCHAR(64) NOT NULL,
			"finished_at" TIMESTAMPTZ,
			"migration_name" VARCHAR(255) NOT NULL,
			"logs" TEXT,
			"rolled_back_at" TIMESTAMPTZ,
			"started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
			"applied_steps_count" INTEGER NOT NULL DEFAULT 0
		)
	`);
}

async function hasPrismaMigrationHistory(client: pg.Client): Promise<boolean> {
	const result = await client.query<{ exists: boolean }>(
		`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`,
	);
	return result.rows[0]?.exists === true;
}

async function hasApplicationTables(client: pg.Client): Promise<boolean> {
	const result = await client.query<{ table_count: string }>(`
		SELECT COUNT(*)::text AS table_count
		FROM information_schema.tables
		WHERE table_schema = 'public'
			AND table_type = 'BASE TABLE'
			AND table_name <> '_prisma_migrations'
	`);
	return Number(result.rows[0]?.table_count ?? "0") > 0;
}

async function readAppliedMigrations(
	client: pg.Client,
): Promise<Map<string, string>> {
	const result = await client.query<{
		migration_name: string;
		checksum: string;
	}>(`
		SELECT migration_name, checksum
		FROM "_prisma_migrations"
		WHERE rolled_back_at IS NULL
	`);
	return new Map(result.rows.map((row) => [row.migration_name, row.checksum]));
}

async function recordMigrationApplied(
	client: pg.Client,
	migration: Migration,
): Promise<void> {
	await client.query(
		`
			INSERT INTO "_prisma_migrations" (
				"id",
				"checksum",
				"finished_at",
				"migration_name",
				"logs",
				"rolled_back_at",
				"started_at",
				"applied_steps_count"
			)
			VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)
		`,
		[randomUUID(), migration.checksum, migration.name],
	);
}

async function markBaselineApplied(
	client: pg.Client,
	migration: Migration,
): Promise<void> {
	await ensureMigrationsTable(client);
	await recordMigrationApplied(client, migration);
	console.info(`Marked existing schema as ${migration.name}.`);
}

async function applyMigration(
	client: pg.Client,
	migration: Migration,
): Promise<void> {
	console.info(`Applying migration ${migration.name}.`);
	await client.query("BEGIN");
	try {
		await client.query(migration.sql);
		await recordMigrationApplied(client, migration);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const migrations = loadMigrations();
const baselineMigration = migrations.find(
	(migration) => migration.name === BASELINE_MIGRATION,
);
if (!baselineMigration) {
	throw new Error(`Missing baseline migration ${BASELINE_MIGRATION}.`);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
	if (
		!(await hasPrismaMigrationHistory(client)) &&
		(await hasApplicationTables(client))
	) {
		await markBaselineApplied(client, baselineMigration);
	}

	await ensureMigrationsTable(client);
	const applied = await readAppliedMigrations(client);
	for (const migration of migrations) {
		const appliedChecksum = applied.get(migration.name);
		if (appliedChecksum === migration.checksum) {
			continue;
		}
		if (appliedChecksum) {
			throw new Error(
				`Migration ${migration.name} was already applied with a different checksum.`,
			);
		}
		await applyMigration(client, migration);
	}
} finally {
	await client.end();
}
