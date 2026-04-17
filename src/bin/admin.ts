import { PermissionsStore } from "../permissions/store";
import { EntrypointSchema } from "../permissions/types";

const DB_PATH = process.env.STATE_DB_PATH || "./state.db";
const USAGE = `Usage:
  bun src/bin/admin.ts add-user <entrypoint> <externalId> [displayName]
  bun src/bin/admin.ts list-users
  bun src/bin/admin.ts list-rules <userId>
  bun src/bin/admin.ts suspend <userId>
  bun src/bin/admin.ts activate <userId>`;

function main(): void {
	const [command, ...rest] = process.argv.slice(2);
	if (!command) {
		console.log(USAGE);
		process.exit(1);
	}

	const store = new PermissionsStore({ dbPath: DB_PATH });

	switch (command) {
		case "add-user": {
			const [entrypointRaw, externalId, ...displayNameParts] = rest;
			if (!entrypointRaw || !externalId) {
				console.log(USAGE);
				process.exit(1);
			}
			const entrypoint = EntrypointSchema.parse(entrypointRaw);
			const user = store.upsertUser({
				entrypoint,
				externalId,
				displayName: displayNameParts.join(" ") || null,
			});
			console.log(`Created ${user.id}`);
			break;
		}
		case "list-users": {
			const users = store.listUsers();
			if (users.length === 0) {
				console.log("(no users)");
				break;
			}
			for (const user of users) {
				console.log(
					`${user.id}\t${user.status}\t${user.displayName ?? "-"}\tcreated=${new Date(user.createdAt).toISOString()}`,
				);
			}
			break;
		}
		case "list-rules": {
			const [userId] = rest;
			if (!userId) {
				console.log(USAGE);
				process.exit(1);
			}
			const rules = store.listRulesForUser(userId);
			if (rules.length === 0) {
				console.log(
					"(no rules; default policy is allow, except execute tools ask)",
				);
				break;
			}
			for (const rule of rules) {
				console.log(
					`[${rule.priority}] ${rule.decision}\t${rule.toolName}${rule.args ? `\targs=${JSON.stringify(rule.args)}` : ""}`,
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
			store.setUserStatus(
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
}

main();
