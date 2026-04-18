import type { BackendProtocol } from "deepagents";
import { overwrite, readOrEmpty } from "./fs";
import { INDEX_HEADING } from "./layout";

// MEMORY.md / SKILLS.md share the same index shape:
//
//   # <Title>
//   <optional header prose>
//
//   ## Index
//   - [topic-slug](/path/to/file.md): one-line hook
//
// Entries under ## Index are the machine-readable contract: one per line,
// `- [slug](path): hook`. Any other content above the ## Index heading is
// preserved verbatim when we rewrite the index.

export type IndexEntry = {
	slug: string;
	path: string;
	hook: string;
};

const ENTRY_REGEX = /^-\s+\[([^\]]+)\]\(([^)]+)\):\s*(.*)$/;

export function parseIndex(content: string): {
	header: string;
	entries: IndexEntry[];
} {
	const indexIdx = content.indexOf(`\n${INDEX_HEADING}`);
	if (indexIdx === -1) {
		return { header: content, entries: [] };
	}
	const header = content.slice(0, indexIdx);
	const body = content.slice(indexIdx + 1 + INDEX_HEADING.length);
	const entries: IndexEntry[] = [];
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		if (line.startsWith("#")) break; // stop at next section
		const match = ENTRY_REGEX.exec(line);
		if (!match) continue;
		entries.push({
			slug: (match[1] ?? "").trim(),
			path: (match[2] ?? "").trim(),
			hook: (match[3] ?? "").trim(),
		});
	}
	return { header, entries };
}

export function formatIndex(header: string, entries: IndexEntry[]): string {
	const headerTrimmed = header.replace(/\n+$/, "");
	const lines = entries
		.slice()
		.sort((a, b) => a.slug.localeCompare(b.slug))
		.map((entry) => `- [${entry.slug}](${entry.path}): ${entry.hook}`);
	const body = lines.length === 0 ? "_No entries yet._" : lines.join("\n");
	return `${headerTrimmed}\n\n${INDEX_HEADING}\n${body}\n`;
}

export function upsertEntry(
	entries: IndexEntry[],
	next: IndexEntry,
): IndexEntry[] {
	const without = entries.filter((entry) => entry.slug !== next.slug);
	return [...without, next];
}

export function removeEntry(entries: IndexEntry[], slug: string): IndexEntry[] {
	return entries.filter((entry) => entry.slug !== slug);
}

export async function readIndexFile(
	backend: BackendProtocol,
	indexPath: string,
): Promise<{ header: string; entries: IndexEntry[] }> {
	const raw = await readOrEmpty(backend, indexPath);
	return parseIndex(raw);
}

export async function upsertIndexFile(
	backend: BackendProtocol,
	indexPath: string,
	entry: IndexEntry,
): Promise<string> {
	const { header, entries } = await readIndexFile(backend, indexPath);
	const next = upsertEntry(entries, entry);
	const composed = formatIndex(header, next);
	await overwrite(backend, indexPath, composed);
	return composed;
}
