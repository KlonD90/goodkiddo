import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	buildDbmateConfig,
	buildDbmateInvocation,
	normalizeDbmateDatabaseUrl,
	readMigrationDatabaseUrl,
} from "./migrate";

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
				"bunx",
				"--bun",
				"dbmate",
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
			"bunx",
			"--bun",
			"dbmate",
			"--url",
			"postgres://localhost/goodkiddo",
			"--migrations-dir",
			join("/repo", "bot", "db", "migrations", "postgres"),
			"new",
			"add_tasks",
		]);
	});
});
