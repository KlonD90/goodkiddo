import { describe, expect, test } from "bun:test";
import { TimerStore } from "../capabilities/timers/store";
import { ensurePostgresBigintColumn } from "./postgres_bigint_columns";
import { PermissionsStore } from "../permissions/store";
import { AccessStore } from "../server/access_store";
import { TaskStore } from "../tasks/store";

type SQL = InstanceType<typeof Bun.SQL>;

function expectBigintMigration(sql: string, column: string): void {
	expect(sql).toContain(`ALTER COLUMN "${column}" TYPE BIGINT`);
}

function createRecordingDb(options?: {
	columnTypeRows?: Array<{ data_type: string; udt_name: string }>;
}): { db: SQL; statements: string[] } {
	const statements: string[] = [];
	const db = ((
		strings: TemplateStringsArray,
		..._values: unknown[]
	): Promise<unknown[]> => {
		const statement = strings.join("?");
		statements.push(statement);
		if (statement.includes("information_schema.columns")) {
			return Promise.resolve(options?.columnTypeRows ?? []);
		}
		return Promise.resolve([]);
	}) as unknown as SQL & { unsafe: (query: string) => Promise<unknown[]> };
	db.unsafe = (query: string): Promise<unknown[]> => {
		statements.push(query);
		return Promise.resolve([]);
	};
	return { db, statements };
}

describe("Postgres schema", () => {
	test("uses BIGINT for epoch-millisecond columns and migrates older integer columns", async () => {
		const permissions = createRecordingDb();
		const permissionsStore = new PermissionsStore({
			db: permissions.db,
			dialect: "postgres",
		});
		await permissionsStore.getUser("telegram", "1");

		expect(permissions.statements.join("\n")).toContain(
			"created_at BIGINT NOT NULL",
		);
		expectBigintMigration(permissions.statements.join("\n"), "created_at");

		const access = createRecordingDb();
		const accessStore = new AccessStore({
			db: access.db,
			dialect: "postgres",
		});
		await accessStore.listActive("telegram:1");

		const accessSql = access.statements.join("\n");
		expect(accessSql).toContain("expires_at BIGINT NOT NULL");
		expect(accessSql).toContain("created_at BIGINT NOT NULL");
		expect(accessSql).toContain("revoked_at BIGINT");
		expectBigintMigration(accessSql, "expires_at");
		expectBigintMigration(accessSql, "created_at");
		expectBigintMigration(accessSql, "revoked_at");

		const tasks = createRecordingDb();
		const taskStore = new TaskStore({ db: tasks.db, dialect: "postgres" });
		await taskStore.ready();

		const taskSql = tasks.statements.join("\n");
		expect(taskSql).toContain("created_at BIGINT NOT NULL");
		expect(taskSql).toContain("updated_at BIGINT NOT NULL");
		expect(taskSql).toContain("completed_at BIGINT");
		expect(taskSql).toContain("dismissed_at BIGINT");
		expectBigintMigration(taskSql, "created_at");
		expectBigintMigration(taskSql, "updated_at");
		expectBigintMigration(taskSql, "completed_at");
		expectBigintMigration(taskSql, "dismissed_at");

		const timers = createRecordingDb();
		const timerStore = new TimerStore({ db: timers.db, dialect: "postgres" });
		await timerStore.ready();

		const timerSql = timers.statements.join("\n");
		expect(timerSql).toContain("last_run_at BIGINT");
		expect(timerSql).toContain("next_run_at BIGINT NOT NULL");
		expect(timerSql).toContain("created_at BIGINT NOT NULL");
		expectBigintMigration(timerSql, "last_run_at");
		expectBigintMigration(timerSql, "next_run_at");
		expectBigintMigration(timerSql, "created_at");
	});

	test("does not issue BIGINT DDL when Postgres column is already bigint", async () => {
		const { db, statements } = createRecordingDb({
			columnTypeRows: [{ data_type: "bigint", udt_name: "int8" }],
		});

		await ensurePostgresBigintColumn(db, "harness_users", "created_at");

		const sql = statements.join("\n");
		expect(sql).toContain("information_schema.columns");
		expect(sql).not.toContain("ALTER TABLE");
	});
});
