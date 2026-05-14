import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

export type AppPrisma = PrismaClient;

export function redactDatabaseUrl(databaseUrl: string): string {
	try {
		const url = new URL(databaseUrl);
		if (url.password) url.password = "****";
		return url.toString();
	} catch {
		return "<invalid DATABASE_URL>";
	}
}

export function createPrismaClient(databaseUrl: string): AppPrisma {
	const adapter = new PrismaPg({ connectionString: databaseUrl });
	return new PrismaClient({
		adapter,
	});
}

export async function assertPrismaConnection(
	prisma: AppPrisma,
	databaseUrl: string,
): Promise<void> {
	try {
		await prisma.$connect();
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Cannot connect to PostgreSQL DATABASE_URL (${redactDatabaseUrl(databaseUrl)}). ` +
				"Start PostgreSQL or configure DATABASE_URL to a reachable PostgreSQL server, then run `bun run db:migrate` before starting the bot.",
			{ cause },
		);
	}
}
