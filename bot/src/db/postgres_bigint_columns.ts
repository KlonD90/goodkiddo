type SQL = InstanceType<typeof Bun.SQL>;

const ALLOWED_BIGINT_COLUMNS = {
	harness_users: ["created_at"],
	fs_access_grants: ["expires_at", "created_at", "revoked_at"],
	tasks: ["created_at", "updated_at", "completed_at", "dismissed_at"],
	timers: ["last_run_at", "next_run_at", "created_at"],
} as const;

export type PostgresBigintTable = keyof typeof ALLOWED_BIGINT_COLUMNS;
export type PostgresBigintColumn =
	(typeof ALLOWED_BIGINT_COLUMNS)[PostgresBigintTable][number];

type ColumnTypeRow = {
	data_type: string;
	udt_name: string;
};

function assertAllowedColumn(
	table: PostgresBigintTable,
	column: PostgresBigintColumn,
): void {
	if (
		!(
			ALLOWED_BIGINT_COLUMNS[table] as readonly PostgresBigintColumn[]
		).includes(column)
	) {
		throw new Error(`Unexpected BIGINT migration target ${table}.${column}`);
	}
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

export async function ensurePostgresBigintColumn(
	db: SQL,
	table: PostgresBigintTable,
	column: PostgresBigintColumn,
): Promise<void> {
	assertAllowedColumn(table, column);

	const rows = await db<ColumnTypeRow[]>`
		SELECT data_type, udt_name
		FROM information_schema.columns
		WHERE table_schema = current_schema()
			AND table_name = ${table}
			AND column_name = ${column}
	`;
	const type = rows[0];
	if (type && (type.data_type === "bigint" || type.udt_name === "int8")) return;

	await db.unsafe(`
		ALTER TABLE ${quoteIdentifier(table)}
		ALTER COLUMN ${quoteIdentifier(column)} TYPE BIGINT
	`);
}
