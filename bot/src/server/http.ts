import type { AppConfig } from "../config";
import { createLogger } from "../logger";
import { AccessStore } from "./access_store";
import { createWebHandler } from "./routes";

const log = createLogger("http");

type BunServer = ReturnType<typeof Bun.serve>;
type SQL = InstanceType<typeof Bun.SQL>;

export interface WebServerHandle {
	access: AccessStore;
	publicBaseUrl: string;
	server: BunServer;
	sweepTimer: ReturnType<typeof setInterval>;
	close: () => Promise<void>;
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export async function startWebServer(
	config: AppConfig,
	options: { db: SQL; dialect: "sqlite" | "postgres" },
): Promise<WebServerHandle> {
	if (!config.webPublicBaseUrl) {
		throw new Error("WEB_PUBLIC_BASE_URL must not be empty");
	}

	const { db, dialect } = options;
	const access = new AccessStore({ db, dialect });
	const handler = createWebHandler({
		access,
		db,
		dialect,
		publicBaseUrl: config.webPublicBaseUrl,
	});

	const server = Bun.serve({
		hostname: config.webHost,
		port: config.webPort,
		async fetch(request) {
			try {
				return await handler(request);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown server error";
				return new Response(JSON.stringify({ error: message }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
		},
	});

	const sweepTimer = setInterval(() => {
		access.sweepExpired().catch((error) => {
			log.warn("AccessStore sweep failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}, SWEEP_INTERVAL_MS);

	log.info("web explorer listening", {
		host: config.webHost,
		port: config.webPort,
		publicBaseUrl: config.webPublicBaseUrl,
	});

	return {
		access,
		publicBaseUrl: config.webPublicBaseUrl,
		server,
		sweepTimer,
		close: async () => {
			clearInterval(sweepTimer);
			server.stop(true);
			access.close();
		},
	};
}
