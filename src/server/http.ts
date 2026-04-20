import type { AppConfig } from "../config";
import { AccessStore } from "./access_store";
import { buildFrontendBundle } from "./frontend_build";
import { createWebHandler } from "./routes";

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
	const bundle = await buildFrontendBundle();
	const handler = createWebHandler({
		access,
		db,
		dialect,
		bundle,
		publicBaseUrl: config.webPublicBaseUrl,
	});

	const server = Bun.serve({
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
			console.warn("AccessStore sweep failed:", error);
		});
	}, SWEEP_INTERVAL_MS);

	console.log(
		`Web explorer listening on port ${config.webPort} (public base: ${config.webPublicBaseUrl}).`,
	);

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
