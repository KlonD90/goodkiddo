import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "dist");

function readPackageCss(relativePath: string): string {
	const candidates = [
		resolve(here, "node_modules", relativePath),
		resolve(here, "..", "node_modules", relativePath),
	];
	for (const fullPath of candidates) {
		try {
			return readFileSync(fullPath, "utf8");
		} catch {
			// Try the next workspace package location.
		}
	}
	throw new Error(`Could not find CSS package asset: ${relativePath}`);
}

mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
	entrypoints: [resolve(here, "src/main.tsx")],
	outdir: outDir,
	target: "browser",
	minify: true,
	format: "iife",
	naming: "main.js",
});

if (!result.success) {
	const logs = result.logs.map((log) => log.message ?? String(log)).join("\n");
	throw new Error(`Web frontend build failed:\n${logs}`);
}

const css = [
	readPackageCss("@mantine/core/styles.css"),
	readPackageCss("highlight.js/styles/github-dark.min.css"),
	readFileSync(resolve(here, "src/styles.css"), "utf8"),
].join("\n");

writeFileSync(resolve(outDir, "main.css"), css);
