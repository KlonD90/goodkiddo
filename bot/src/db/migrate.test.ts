import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDbmateConfig,
	buildDbmateInvocation,
	migrateDatabase,
	normalizeDbmateDatabaseUrl,
	readMigrationDatabaseUrl,
} from "./migrate";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
	);
});

const createTempDir = async (): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "goodkiddo-migrate-"));
	tempDirs.push(dir);
	return dir;
};

describe("normalizeDbmateDatabaseUrl", () => {
	test("normalizes Bun relative sqlite URLs for dbmate", () => {
		expect(normalizeDbmateDatabaseUrl("sqlite://./state.db")).toBe(
			"sqlite:./state.db",
		);
		expect(normalizeDbmateDatabaseUrl("sqlite://../state.db")).toBe(
			"sqlite:../state.db",
		);
	});

	test("keeps sqlite URLs that dbmate already accepts", () => {
		expect(normalizeDbmateDatabaseUrl("sqlite:./state.db")).toBe(
			"sqlite:./state.db",
		);
		expect(normalizeDbmateDatabaseUrl("sqlite:///tmp/state.db")).toBe(
			"sqlite:///tmp/state.db",
		);
	});

	test("keeps postgres URLs unchanged", () => {
		expect(
			normalizeDbmateDatabaseUrl("postgres://user:pass@localhost/goodkiddo"),
		).toBe("postgres://user:pass@localhost/goodkiddo");
		expect(
			normalizeDbmateDatabaseUrl("postgresql://user:pass@localhost/goodkiddo"),
		).toBe("postgresql://user:pass@localhost/goodkiddo");
	});
});

describe("buildDbmateConfig", () => {
	test("selects sqlite migrations and normalized URL", () => {
		expect(buildDbmateConfig("sqlite://./state.db", "/repo")).toEqual({
			dialect: "sqlite",
			databaseUrl: "sqlite:./state.db",
			migrationsDir: join("/repo", "bot", "db", "migrations", "sqlite"),
		});
	});

	test("selects postgres migrations and leaves URL unchanged", () => {
		expect(
			buildDbmateConfig("postgres://localhost/goodkiddo", "/repo"),
		).toEqual({
			dialect: "postgres",
			databaseUrl: "postgres://localhost/goodkiddo",
			migrationsDir: join("/repo", "bot", "db", "migrations", "postgres"),
		});
	});
});

describe("readMigrationDatabaseUrl", () => {
	test("uses DATABASE_URL from env", () => {
		expect(
			readMigrationDatabaseUrl({
				DATABASE_URL: "postgres://localhost/goodkiddo",
			}),
		).toBe("postgres://localhost/goodkiddo");
	});

	test("uses app config default when DATABASE_URL is unset", () => {
		expect(readMigrationDatabaseUrl({})).toBe("sqlite://./state.db");
	});

	test("uses explicit env over process env", () => {
		const previousDatabaseUrl = process.env.DATABASE_URL;
		process.env.DATABASE_URL = "postgres://localhost/prod";
		try {
			expect(
				readMigrationDatabaseUrl({
					DATABASE_URL: "sqlite://./state.db",
				}),
			).toBe("sqlite://./state.db");
		} finally {
			if (previousDatabaseUrl === undefined) {
				delete process.env.DATABASE_URL;
			} else {
				process.env.DATABASE_URL = previousDatabaseUrl;
			}
		}
	});

	test("uses persisted app config when DATABASE_URL is not in env", async () => {
		const dir = await createTempDir();
		const envFilePath = join(dir, ".env");
		await writeFile(
			envFilePath,
			'DATABASE_URL="postgres://localhost/goodkiddo"\n',
			"utf8",
		);

		expect(readMigrationDatabaseUrl({}, { envFilePath })).toBe(
			"postgres://localhost/goodkiddo",
		);
	});
});

describe("buildDbmateInvocation", () => {
	test("builds migrate command for the selected dialect", () => {
		expect(
			buildDbmateInvocation("up", {
				env: { DATABASE_URL: "sqlite://./state.db" },
				repoRoot: "/repo",
			}),
		).toEqual({
			command: [
				"bun",
				join("/repo", "bot", "node_modules", "dbmate", "dist", "cli.js"),
				"--url",
				"sqlite:./state.db",
				"--migrations-dir",
				join("/repo", "bot", "db", "migrations", "sqlite"),
				"up",
			],
			env: {
				DATABASE_URL: "sqlite:./state.db",
			},
		});
	});

	test("passes extra args through for db:new", () => {
		expect(
			buildDbmateInvocation("new", {
				env: { DATABASE_URL: "postgres://localhost/goodkiddo" },
				extraArgs: ["add_tasks"],
				repoRoot: "/repo",
			}).command,
		).toEqual([
			"bun",
			join("/repo", "bot", "node_modules", "dbmate", "dist", "cli.js"),
			"--url",
			"postgres://localhost/goodkiddo",
			"--migrations-dir",
			join("/repo", "bot", "db", "migrations", "postgres"),
			"new",
			"add_tasks",
		]);
	});

	test("sets normalized DATABASE_URL and preserves defined env values", () => {
		expect(
			buildDbmateInvocation("status", {
				env: {
					DATABASE_URL: "sqlite://../state.db",
					GOODKIDDO_ENV: "test",
					UNSET_VALUE: undefined,
				},
				repoRoot: "/repo",
			}).env,
		).toEqual({
			DATABASE_URL: "sqlite:../state.db",
			GOODKIDDO_ENV: "test",
		});
	});

	test("builds rollback without shelling out", () => {
		expect(
			buildDbmateInvocation("rollback", {
				env: { DATABASE_URL: "postgresql://localhost/goodkiddo" },
				repoRoot: "/repo",
			}),
		).toEqual({
			command: [
				"bun",
				join("/repo", "bot", "node_modules", "dbmate", "dist", "cli.js"),
				"--url",
				"postgresql://localhost/goodkiddo",
				"--migrations-dir",
				join("/repo", "bot", "db", "migrations", "postgres"),
				"rollback",
			],
			env: {
				DATABASE_URL: "postgresql://localhost/goodkiddo",
			},
		});
	});
});

describe("migrateDatabase", () => {
	test("runs dbmate up before application database use", async () => {
		const invocations: ReturnType<typeof buildDbmateInvocation>[] = [];

		await migrateDatabase({
			env: { DATABASE_URL: "sqlite://./state.db" },
			repoRoot: "/repo",
			runner: async (invocation) => {
				invocations.push(invocation);
				return 0;
			},
		});

		expect(invocations).toEqual([
			buildDbmateInvocation("up", {
				env: { DATABASE_URL: "sqlite://./state.db" },
				repoRoot: "/repo",
			}),
		]);
	});

	test("fails startup when dbmate up fails", async () => {
		await expect(
			migrateDatabase({
				env: { DATABASE_URL: "sqlite://./state.db" },
				repoRoot: "/repo",
				runner: async () => 1,
			}),
		).rejects.toThrow("Database migration failed with exit code 1");
	});
});
