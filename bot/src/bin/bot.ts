import { DEFAULT_DATABASE_URL, maskSecret, resolveConfig } from "../config";
import { createLogger } from "../logger";

const log = createLogger("startup");
const botRoot = new URL("../..", import.meta.url).pathname;

async function runCommand(
	args: string[],
	options: { captureStdout?: boolean } = {},
): Promise<string> {
	const proc = Bun.spawn(args, {
		cwd: botRoot,
		stdout: options.captureStdout ? "pipe" : "inherit",
		stderr: "inherit",
		env: process.env,
	});
	const [exitCode, stdout] = await Promise.all([
		proc.exited,
		options.captureStdout
			? new Response(proc.stdout).text()
			: Promise.resolve(""),
	]);
	if (exitCode !== 0) {
		throw new Error(`Command failed: ${args.join(" ")}`);
	}
	return stdout;
}

function extractPrismaDevDatabaseUrl(output: string): string {
	const match = output.match(/postgres:\/\/[^\s]+/u);
	if (!match) {
		throw new Error(
			"Failed to discover Prisma Dev DATABASE_URL from `bun run db:dev` output.",
		);
	}
	return match[0];
}

async function canImportPrismaClient(): Promise<boolean> {
	const proc = Bun.spawn(["bun", "-e", "await import('@prisma/client')"], {
		cwd: botRoot,
		stdout: "ignore",
		stderr: "ignore",
		env: process.env,
	});
	return (await proc.exited) === 0;
}

async function prepareLocalPrismaDevDatabase(
	configuredDatabaseUrl: string,
): Promise<string | null> {
	if (configuredDatabaseUrl !== DEFAULT_DATABASE_URL) {
		return null;
	}

	log.info("DATABASE_URL is default; starting local Prisma Dev database");
	const output = await runCommand(["bun", "run", "db:dev"], {
		captureStdout: true,
	});
	const databaseUrl = extractPrismaDevDatabaseUrl(output);
	process.env.DATABASE_URL = databaseUrl;

	if (!(await canImportPrismaClient())) {
		log.info("Prisma client is missing; generating it");
		await runCommand(["bun", "run", "db:generate"]);
	}

	log.info("Applying Prisma migrations to local development database");
	await runCommand(["bun", "run", "db:migrate"]);
	return databaseUrl;
}

const config = await resolveConfig();
const localDatabaseUrl = await prepareLocalPrismaDevDatabase(
	config.databaseUrl,
);
if (localDatabaseUrl) {
	config.databaseUrl = localDatabaseUrl;
}

const { runAppChannel } = await import("../channels");
const { assertPrismaConnection, createPrismaClient, redactDatabaseUrl } =
	await import("../db/prisma");
const { startWebServer } = await import("../server/http");

const prisma = createPrismaClient(config.databaseUrl);
await assertPrismaConnection(prisma, config.databaseUrl);

log.info("config loaded", {
	appEntrypoint: config.appEntrypoint,
	aiType: config.aiType,
	aiModelName: config.aiModelName,
	aiApiKey: maskSecret(config.aiApiKey),
	aiBaseUrl: config.aiBaseUrl,
	databaseUrl: redactDatabaseUrl(config.databaseUrl),
});

if (config.appEntrypoint === "telegram") {
	log.info("telegram config", {
		telegramBotToken: maskSecret(config.telegramBotToken),
		telegramAllowedChatId:
			config.telegramAllowedChatId === ""
				? "<any>"
				: config.telegramAllowedChatId,
	});
}

const webServer = await startWebServer(config, { prisma });
const shutdown = async () => {
	await webServer.close();
	await prisma.$disconnect();
};
process.on("SIGINT", () => {
	void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
	void shutdown().finally(() => process.exit(0));
});

await runAppChannel(config, {
	prisma,
	webShare: {
		access: webServer.access,
		publicBaseUrl: webServer.publicBaseUrl,
	},
});
