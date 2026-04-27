import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger";

const log = createLogger("frontend.build");

export interface FrontendBundle {
	js: string;
	css: string;
}

const FALLBACK_JS = `
document.getElementById("root").innerHTML = "<div style='padding:24px;color:#ff7a7a;font-family:sans-serif'>Frontend bundle unavailable. Check server logs.</div>";
`;

const FALLBACK_CSS = ":root { color-scheme: dark; } body { margin: 0; }";

function webDistCandidates(): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	return [
		resolve(process.cwd(), "web", "dist"),
		resolve(process.cwd(), "..", "web", "dist"),
		resolve(here, "..", "..", "..", "web", "dist"),
	];
}

export async function buildFrontendBundle(): Promise<FrontendBundle> {
	const searched = webDistCandidates();
	for (const distDir of searched) {
		const jsPath = resolve(distDir, "main.js");
		const cssPath = resolve(distDir, "main.css");
		if (existsSync(jsPath) && existsSync(cssPath)) {
			return {
				js: readFileSync(jsPath, "utf8"),
				css: readFileSync(cssPath, "utf8"),
			};
		}
	}

	log.warn("web frontend bundle unavailable", { searched });
	return makeStubBundle();
}

export function makeStubBundle(): FrontendBundle {
	return { js: FALLBACK_JS, css: FALLBACK_CSS };
}
