#!/usr/bin/env -S bun run
/**
 * Dev server — serves web/static files directly and proxies API routes
 * to the bot (expecting it running on :8083).
 *
 * Usage:
 *   bun run dev          # starts on :3000
 *   PORT=8080 bun run dev  # custom port
 *   BOT_API_URL=http://localhost:9000 bun run dev  # custom upstream
 */

import { startDevServer } from "../server/dev_server";
import { createLogger } from "../logger";

const log = createLogger("dev");

const PORT = Number(process.env.PORT) || 3000;

const server = await startDevServer(PORT);

process.on("SIGINT", () => {
	log.info("shutting down dev server");
	server.close();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.info("shutting down dev server");
	server.close();
	process.exit(0);
});
