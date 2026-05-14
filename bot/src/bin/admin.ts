import { detectDialect } from "../db/index";
import { assertPrismaConnection, createPrismaClient } from "../db/prisma";
import { PermissionsStore } from "../permissions/store";
import { EntrypointSchema } from "../permissions/types";

const DATABASE_URL = process.env.DATABASE_URL;
const USAGE = `Usage:
  bun src/bin/admin.ts add-user <entrypoint> <externalId> [displayName]
  bun src/bin/admin.ts list-users
  bun src/bin/admin.ts suspend <userId>
  bun src/bin/admin.ts activate <userId>`;

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	if (!command) {
		console.log(USAGE);
		process.exit(1);
	}

	if (!DATABASE_URL) {
		throw new Error("DATABASE_URL is required and must be a PostgreSQL URL.");
	}
	const dialect = detectDialect(DATABASE_URL);
	if (dialect !== "postgres") {
		throw new Error("DATABASE_URL must be a PostgreSQL URL.");
	}
	const prisma = createPrismaClient(DATABASE_URL);
	await assertPrismaConnection(prisma, DATABASE_URL);
	const store = new PermissionsStore({ prisma });

	switch (command) {
		case "add-user": {
			const [entrypointRaw, externalId, ...displayNameParts] = rest;
			if (!entrypointRaw || !externalId) {
				console.log(USAGE);
				process.exit(1);
			}
			const entrypoint = EntrypointSchema.parse(entrypointRaw);
			const user = await store.upsertUserPaid({
				entrypoint,
				externalId,
				displayName: displayNameParts.join(" ") || null,
			});
			const action = user.tier === "paid" ? "Created" : "Upgraded";
			console.log(`${action} ${user.id} (tier=${user.tier})`);
			break;
		}
		case "list-users": {
			const users = await store.listUsers();
			if (users.length === 0) {
				console.log("(no users)");
				break;
			}
			for (const user of users) {
				console.log(
					`${user.id}\t${user.tier}\t${user.status}\t${user.displayName ?? "-"}\tcreated=${new Date(user.createdAt).toISOString()}`,
				);
			}
			break;
		}
		case "suspend":
		case "activate": {
			const [userId] = rest;
			if (!userId) {
				console.log(USAGE);
				process.exit(1);
			}
			await store.setUserStatus(
				userId,
				command === "suspend" ? "suspended" : "active",
			);
			console.log(`${userId} ${command}d`);
			break;
		}
		default:
			console.log(USAGE);
			process.exit(1);
	}

	store.close();
	await prisma.$disconnect();
}

main();
