import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfigFromEnv } from "../config";
import { detectDialect } from "./index";

export type MigrationDialect = "sqlite" | "postgres";
export type DbmateCommand = "up" | "status" | "rollback" | "new";

export interface DbmateConfig {
	dialect: MigrationDialect;
	databaseUrl: string;
	migrationsDir: string;
}

export interface DbmateInvocation {
	command: string[];
	env: Record<string, string>;
}

const DEFAULT_REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);

export const normalizeDbmateDatabaseUrl = (databaseUrl: string): string => {
	const dialect = detectDialect(databaseUrl);
	if (dialect !== "sqlite") {
		return databaseUrl;
	}

	if (databaseUrl.startsWith("sqlite://./")) {
		return `sqlite:./${databaseUrl.slice("sqlite://./".length)}`;
	}

	if (databaseUrl.startsWith("sqlite://../")) {
		return `sqlite:../${databaseUrl.slice("sqlite://../".length)}`;
	}

	return databaseUrl;
};

export const buildDbmateConfig = (
	databaseUrl: string,
	repoRoot = DEFAULT_REPO_ROOT,
): DbmateConfig => {
	const dialect = detectDialect(databaseUrl);

	return {
		dialect,
		databaseUrl: normalizeDbmateDatabaseUrl(databaseUrl),
		migrationsDir: join(repoRoot, "bot", "db", "migrations", dialect),
	};
};

export const readMigrationDatabaseUrl = (
	env: Record<string, string | undefined> = process.env,
): string => readConfigFromEnv(env).databaseUrl ?? "sqlite://./state.db";

export const buildDbmateInvocation = (
	dbmateCommand: DbmateCommand,
	options: {
		databaseUrl?: string;
		extraArgs?: string[];
		repoRoot?: string;
		env?: Record<string, string | undefined>;
	} = {},
): DbmateInvocation => {
	const config = buildDbmateConfig(
		options.databaseUrl ?? readMigrationDatabaseUrl(options.env),
		options.repoRoot,
	);

	return {
		command: [
			"bunx",
			"--bun",
			"dbmate",
			"--url",
			config.databaseUrl,
			"--migrations-dir",
			config.migrationsDir,
			dbmateCommand,
			...(options.extraArgs ?? []),
		],
		env: {
			...Object.fromEntries(
				Object.entries(options.env ?? process.env).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			),
			DATABASE_URL: config.databaseUrl,
		},
	};
};

export const runDbmate = async (
	dbmateCommand: DbmateCommand,
	extraArgs = process.argv.slice(3),
): Promise<number> => {
	const invocation = buildDbmateInvocation(dbmateCommand, { extraArgs });
	const proc = Bun.spawn(invocation.command, {
		env: invocation.env,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});

	return await proc.exited;
};

if (import.meta.main) {
	const command = process.argv[2] as DbmateCommand | undefined;
	if (
		command !== "up" &&
		command !== "status" &&
		command !== "rollback" &&
		command !== "new"
	) {
		console.error(
			"Usage: bun src/db/migrate.ts <up|status|rollback|new> [dbmate args...]",
		);
		process.exit(2);
	}

	process.exit(await runDbmate(command));
}
