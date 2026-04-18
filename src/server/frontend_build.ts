import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FrontendBundle {
	js: string;
	css: string;
}

const BASE_CSS = `
:root {
	color-scheme: light dark;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: #0f1115; color: #e8ebf0; }
#root { display: grid; grid-template-columns: 320px 1fr; min-height: 100vh; }
nav { border-right: 1px solid #23262d; padding: 16px; overflow-y: auto; }
main { padding: 24px; overflow: auto; }
.breadcrumbs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 12px; font-size: 13px; color: #8a919c; }
.breadcrumbs .breadcrumb { background: none; border: none; padding: 0; color: #7ec8ff; cursor: pointer; font: inherit; }
.breadcrumbs .breadcrumb:hover { text-decoration: underline; }
.breadcrumbs span { color: #8a919c; }
ul.file-list { list-style: none; padding: 0; margin: 0; }
ul.file-list li { padding: 6px 8px; cursor: pointer; border-radius: 4px; display: flex; justify-content: space-between; gap: 8px; font-size: 14px; }
ul.file-list li:hover { background: #1a1d24; }
ul.file-list li.active { background: #233044; }
.size { color: #8a919c; font-size: 12px; }
.preview { background: #161922; border: 1px solid #23262d; border-radius: 6px; padding: 16px; }
.preview img { max-width: 100%; height: auto; }
.preview pre { overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: "SF Mono", "Menlo", monospace; font-size: 13px; }
.preview .markdown h1, .preview .markdown h2, .preview .markdown h3 { margin-top: 1em; }
.preview .markdown code { background: #0f1115; padding: 2px 4px; border-radius: 3px; }
.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
button, a.button { cursor: pointer; background: #233044; color: #e8ebf0; border: 1px solid #2e3b54; border-radius: 4px; padding: 6px 12px; font-size: 13px; text-decoration: none; display: inline-block; }
button:hover, a.button:hover { background: #2e3b54; }
.error { color: #ff7a7a; padding: 12px; }
`;

const FALLBACK_JS = `
document.getElementById("root").innerHTML = "<div class='error'>Frontend bundle unavailable.</div>";
`;

async function tryBuild(entry: string): Promise<string | null> {
	try {
		const result = await Bun.build({
			entrypoints: [entry],
			target: "browser",
			minify: true,
			format: "iife",
		});
		if (!result.success || result.outputs.length === 0) return null;
		const chunks = await Promise.all(
			result.outputs.map((output) => output.text()),
		);
		return chunks.join("\n");
	} catch {
		return null;
	}
}

export async function buildFrontendBundle(): Promise<FrontendBundle> {
	const here = dirname(fileURLToPath(import.meta.url));
	const entry = join(here, "frontend", "main.tsx");

	let js = await tryBuild(entry);
	if (!js) js = FALLBACK_JS;

	let css = BASE_CSS;
	try {
		const cssPath = join(here, "frontend", "styles.css");
		const extra = readFileSync(cssPath, "utf8");
		css = `${BASE_CSS}\n${extra}`;
	} catch {
		/* styles.css optional */
	}

	return { js, css };
}

export function makeStubBundle(): FrontendBundle {
	return { js: FALLBACK_JS, css: BASE_CSS };
}
