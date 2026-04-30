import { join } from "node:path";
import { detectDialect } from "./index";

export type MigrationDialect = "sqlite" | "postgres";

export interface DbmateConfig {
	dialect: MigrationDialect;
	databaseUrl: string;
	migrationsDir: string;
}

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
	repoRoot = process.cwd(),
): DbmateConfig => {
	const dialect = detectDialect(databaseUrl);

	return {
		dialect,
		databaseUrl: normalizeDbmateDatabaseUrl(databaseUrl),
		migrationsDir: join(repoRoot, "bot", "db", "migrations", dialect),
	};
};
