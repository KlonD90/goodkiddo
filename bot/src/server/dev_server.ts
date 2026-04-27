import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger";

const log = createLogger("dev_server");
const here = dirname(fileURLToPath(import.meta.url));

const WEB_DIST = resolve(here, "..", "..", "..", "web", "dist");

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".pdf": "application/pdf",
};

function mimeFor(pathname: string): string {
	return MIME_TYPES[extname(pathname)] ?? "application/octet-stream";
}

async function serveStatic(pathname: string): Promise<Response | null> {
	if (pathname === "/" || pathname === "") {
		pathname = "/index.html";
	}
	const filePath = join(WEB_DIST, pathname);
	if (!existsSync(filePath)) return null;
	const file = Bun.file(filePath);
	if (!(await file.exists())) return null;
	const ext = extname(pathname);
	const isAsset =
		[".js", ".css"].includes(ext) ||
		/^[a-f0-9]+\.js$/.test(pathname);
	return new Response(file.stream(), {
		headers: {
			"content-type": mimeFor(pathname),
			"cache-control": isAsset
				? "public, max-age=31536000, immutable"
				: "no-store",
		},
	});
}

const UPSTREAM = process.env.BOT_API_URL ?? "http://127.0.0.1:8083";

export async function startDevServer(port: number): Promise<{
	close: () => Promise<void>;
}> {
	log.info("dev server listening", { port, upstream: UPSTREAM });

	const server = Bun.serve({
		port,
		async fetch(request) {
			const url = new URL(request.url);
			const pathname = url.pathname;

			// Proxy API routes to bot
			if (
				pathname.startsWith("/api/fs/") ||
				pathname === "/_boot" ||
				pathname.startsWith("/_boot?") ||
				pathname === "/_dl" ||
				pathname.startsWith("/_dl?")
			) {
				const upstreamUrl = UPSTREAM + pathname + url.search;
				const headers = new Headers(request.headers);
				headers.set("host", new URL(UPSTREAM).host);
				try {
					return await fetch(upstreamUrl, {
						method: request.method,
						headers,
						body: request.body,
					});
				} catch (error) {
					log.error("proxy error", {
						url: upstreamUrl,
						error:
							error instanceof Error ? error.message : String(error),
					});
					return new Response("Service unavailable", { status: 503 });
				}
			}

			// Serve static files
			const staticResponse = await serveStatic(pathname);
			if (staticResponse) return staticResponse;

			// SPA fallback
			const indexPath = join(WEB_DIST, "index.html");
			if (existsSync(indexPath)) {
				return new Response(Bun.file(indexPath).stream(), {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			return new Response("Not found", { status: 404 });
		},
	});

	return {
		close: async () => {
			server.stop(true);
		},
	};
}
