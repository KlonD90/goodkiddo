import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface FrontendBundle {
	js: string;
	css: string;
}

const APP_CSS = `
:root { color-scheme: dark; }
body { margin: 0; }
.fs-shell { min-height: 100vh; }

/* Breadcrumbs single-line + ellipsis */
.fs-breadcrumbs { min-width: 0; flex-wrap: nowrap; overflow: hidden; }
.fs-breadcrumbs > * { min-width: 0; }
.fs-breadcrumb-item { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

/* Markdown styling */
.fs-preview a { color: var(--mantine-color-blue-4); }
.fs-preview img { max-width: 100%; height: auto; border-radius: 6px; }
.fs-preview pre { overflow: auto; white-space: pre-wrap; word-break: break-word; }
.fs-preview code { font-family: "SF Mono", "Menlo", ui-monospace, monospace; }
.fs-preview .markdown { line-height: 1.6; }
.fs-preview .markdown > *:first-child { margin-top: 0; }
.fs-preview .markdown > *:last-child { margin-bottom: 0; }
.fs-preview .markdown p { margin: 0.5em 0; }
.fs-preview .markdown h1,
.fs-preview .markdown h2,
.fs-preview .markdown h3,
.fs-preview .markdown h4 { margin-top: 0.7em; margin-bottom: 0.4em; }
.fs-preview .markdown ul,
.fs-preview .markdown ol { padding-left: 1.6em; margin: 0.5em 0; }
.fs-preview .markdown li { margin: 0.2em 0; }
.fs-preview .markdown blockquote { border-left: 3px solid var(--mantine-color-dark-3); margin: 0.5em 0; padding: 0.2em 0.9em; color: var(--mantine-color-dimmed); }
.fs-preview .markdown code:not(pre code) { background: var(--mantine-color-dark-6); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
.fs-preview .markdown pre { background: var(--mantine-color-dark-8); padding: 12px 14px; border-radius: 6px; margin: 0.5em 0; }
.fs-preview .markdown table { border-collapse: collapse; margin: 0.6em 0; }
.fs-preview .markdown th,
.fs-preview .markdown td { border: 1px solid var(--mantine-color-dark-4); padding: 6px 10px; }
.fs-preview .markdown hr { border: none; border-top: 1px solid var(--mantine-color-dark-4); margin: 1em 0; }

/* Code preview block */
.fs-code-preview { background: var(--mantine-color-dark-8); border-radius: 6px; overflow: auto; margin: 0; }
.fs-code-preview pre { margin: 0; padding: 14px 16px; background: transparent; }
.fs-code-preview code.hljs { padding: 0; background: transparent; font-family: "SF Mono", "Menlo", ui-monospace, monospace; font-size: 13px; line-height: 1.55; }
`;

const FALLBACK_JS = `
document.getElementById("root").innerHTML = "<div style='padding:24px;color:#ff7a7a;font-family:sans-serif'>Frontend bundle unavailable. Check server logs.</div>";
`;

function readVendorCss(relativePath: string): string {
	try {
		const fullPath = resolve(process.cwd(), "node_modules", relativePath);
		return readFileSync(fullPath, "utf8");
	} catch (error) {
		console.warn(`Could not load ${relativePath}:`, error);
		return "";
	}
}

async function tryBuild(entry: string): Promise<string | null> {
	try {
		const result = await Bun.build({
			entrypoints: [entry],
			target: "browser",
			minify: true,
			format: "iife",
		});
		if (!result.success || result.outputs.length === 0) {
			console.warn(
				`Frontend build failed for ${entry}:`,
				result.logs.map((log) => log.message ?? String(log)).join("\n"),
			);
			return null;
		}
		const chunks = await Promise.all(
			result.outputs.map((output) => output.text()),
		);
		return chunks.join("\n");
	} catch (error) {
		console.warn(`Frontend build threw for ${entry}:`, error);
		return null;
	}
}

export async function buildFrontendBundle(): Promise<FrontendBundle> {
	const here = dirname(fileURLToPath(import.meta.url));
	const entry = join(here, "frontend", "main.tsx");

	let js = await tryBuild(entry);
	if (!js) js = FALLBACK_JS;

	const mantineCss = readVendorCss("@mantine/core/styles.css");
	const hljsCss = readVendorCss("highlight.js/styles/github-dark.min.css");
	const css = `${mantineCss}\n${hljsCss}\n${APP_CSS}`;

	return { js, css };
}

export function makeStubBundle(): FrontendBundle {
	return { js: FALLBACK_JS, css: APP_CSS };
}
