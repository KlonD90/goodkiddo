import MarkdownIt from "markdown-it";
import {
	TELEGRAM_MAX_MESSAGE_LENGTH,
	TELEGRAM_MAX_CAPTION_LENGTH,
} from "./types";
import type {
	MarkdownTableBlock,
	TelegramListState,
	TelegramMarkdownChunkContext,
	TelegramMarkdownRenderEnv,
	TrailingMarkdownTableContext,
} from "./types";

// --- Markdown chunk context scanning ---

export function scanTelegramMarkdownChunkContext(
	text: string,
): TelegramMarkdownChunkContext {
	const openDelimiters: string[] = [];
	let inCodeFence = false;
	let inInlineCode = false;
	let index = 0;

	while (index < text.length) {
		const current = text[index] ?? "";
		const atLineStart = index === 0 || text[index - 1] === "\n";

		if (current === "\\") {
			index += 2;
			continue;
		}

		if (atLineStart && text.startsWith("```", index)) {
			inCodeFence = !inCodeFence;
			index += 3;
			continue;
		}

		if (inCodeFence) {
			index += 1;
			continue;
		}

		if (current === "`") {
			inInlineCode = !inInlineCode;
			index += 1;
			continue;
		}

		if (inInlineCode) {
			index += 1;
			continue;
		}

		const delimiter = text.startsWith("**", index)
			? "**"
			: text.startsWith("__", index)
				? "__"
				: text.startsWith("~~", index)
					? "~~"
					: null;
		if (delimiter !== null) {
			if (openDelimiters.at(-1) === delimiter) {
				openDelimiters.pop();
			} else {
				openDelimiters.push(delimiter);
			}
			index += delimiter.length;
			continue;
		}

		index += 1;
	}

	return {
		openDelimiters,
		inCodeFence,
		inInlineCode,
		trailingTable: findTrailingMarkdownTableContext(text),
	};
}

export function hasOpenTelegramMarkdownStructures(
	context: TelegramMarkdownChunkContext,
): boolean {
	return (
		context.inCodeFence ||
		context.inInlineCode ||
		context.openDelimiters.length > 0
	);
}

export function isSafeTelegramMarkdownChunk(text: string): boolean {
	const context = scanTelegramMarkdownChunkContext(text);
	return (
		!hasOpenTelegramMarkdownStructures(context) &&
		context.trailingTable === null
	);
}

// --- Markdown table helpers ---

function splitMarkdownTableRow(line: string): string[] {
	let normalized = line.trim();
	if (normalized.startsWith("|")) normalized = normalized.slice(1);
	if (normalized.endsWith("|")) normalized = normalized.slice(0, -1);

	const cells: string[] = [];
	let current = "";
	let escaping = false;

	for (const character of normalized) {
		if (escaping) {
			current += character;
			escaping = false;
			continue;
		}

		if (character === "\\") {
			escaping = true;
			continue;
		}

		if (character === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}

		current += character;
	}

	if (escaping) current += "\\";
	cells.push(current.trim());
	return cells.map((cell) => cell.replaceAll("\\|", "|"));
}

function isMarkdownTableSeparator(line: string): boolean {
	return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?\|?\s*$/.test(line);
}

function looksLikeMarkdownTableHeader(line: string): boolean {
	return /\|/.test(line);
}

function looksLikeMarkdownTableRow(line: string): boolean {
	return /\|/.test(line) && line.trim() !== "";
}

function findTrailingMarkdownTableContext(
	text: string,
): TrailingMarkdownTableContext | null {
	if (text.trim() === "") return null;
	if (/\n\s*\n\s*$/.test(text)) return null;

	const lines = text.split("\n");
	const lineStarts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineStarts.push(offset);
		offset += line.length + 1;
	}

	let lastNonEmpty = lines.length - 1;
	while (lastNonEmpty >= 0 && lines[lastNonEmpty]?.trim() === "") {
		lastNonEmpty -= 1;
	}
	if (lastNonEmpty < 1) return null;

	let start = lastNonEmpty;
	while (start >= 0) {
		const line = lines[start] ?? "";
		if (
			looksLikeMarkdownTableRow(line) ||
			isMarkdownTableSeparator(line) ||
			looksLikeMarkdownTableHeader(line)
		) {
			start -= 1;
			continue;
		}
		break;
	}
	start += 1;

	const blockLines = lines.slice(start, lastNonEmpty + 1);
	if (blockLines.length < 2) return null;
	if (!looksLikeMarkdownTableHeader(blockLines[0] ?? "")) return null;
	if (!isMarkdownTableSeparator(blockLines[1] ?? "")) return null;
	if (
		!blockLines
			.slice(2)
			.every((line) => looksLikeMarkdownTableRow(line) && line.trim() !== "")
	) {
		return null;
	}

	return {
		start: lineStarts[start] ?? 0,
		header: blockLines[0] ?? "",
		separator: blockLines[1] ?? "",
		rows: blockLines.slice(2),
	};
}

function findLargestMarkdownTableBlock(
	text: string,
): MarkdownTableBlock | null {
	const lines = text.split("\n");
	const lineStarts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineStarts.push(offset);
		offset += line.length + 1;
	}

	let largest: MarkdownTableBlock | null = null;

	for (let index = 0; index < lines.length - 1; index += 1) {
		const header = lines[index] ?? "";
		const separator = lines[index + 1] ?? "";
		if (!looksLikeMarkdownTableHeader(header)) continue;
		if (!isMarkdownTableSeparator(separator)) continue;

		const rows: string[] = [];
		let cursor = index + 2;
		while (
			cursor < lines.length &&
			looksLikeMarkdownTableRow(lines[cursor] ?? "")
		) {
			rows.push(lines[cursor] ?? "");
			cursor += 1;
		}
		if (rows.length === 0) continue;

		const start = lineStarts[index] ?? 0;
		const end =
			cursor < lines.length ? (lineStarts[cursor] ?? text.length) : text.length;
		const candidate: MarkdownTableBlock = {
			start,
			end,
			header,
			separator,
			rows,
		};

		if (
			largest === null ||
			candidate.end - candidate.start > largest.end - largest.start
		) {
			largest = candidate;
		}

		index = cursor - 1;
	}

	return largest;
}

function buildMarkdownTable(headers: string[], rows: string[][]): string {
	const separator = headers.map(() => "---");
	const formatRow = (cells: string[]) =>
		`| ${cells.map((cell) => cell.trim()).join(" | ")} |`;
	return [
		formatRow(headers),
		formatRow(separator),
		...rows.map((row) =>
			formatRow(headers.map((_, index) => row[index] ?? "")),
		),
	].join("\n");
}

function splitMarkdownContent(text: string): [string, string] | null {
	const normalized = text.trim();
	if (normalized === "") return null;

	const midpoint = Math.floor(normalized.length / 2);
	const separators = ["\n\n", "\n", ". ", "; ", ", ", " "];

	for (const separator of separators) {
		let boundary = -1;
		let searchFrom = 0;
		while (true) {
			const next = normalized.indexOf(separator, searchFrom);
			if (next === -1) break;
			const candidate = next + separator.length;
			if (
				candidate >= Math.floor(normalized.length * 0.25) &&
				candidate <= Math.ceil(normalized.length * 0.75)
			) {
				boundary = candidate;
			}
			searchFrom = next + 1;
		}
		if (boundary !== -1) {
			const first = normalized.slice(0, boundary).trim();
			const second = normalized.slice(boundary).trim();
			if (first !== "" && second !== "") {
				return [first, second];
			}
		}
	}

	for (let offset = 0; offset < normalized.length / 2; offset += 1) {
		const right = midpoint + offset;
		if (right < normalized.length && /\s/.test(normalized[right] ?? "")) {
			const first = normalized.slice(0, right).trim();
			const second = normalized.slice(right).trim();
			if (first !== "" && second !== "") {
				return [first, second];
			}
		}

		const left = midpoint - offset;
		if (left > 0 && /\s/.test(normalized[left] ?? "")) {
			const first = normalized.slice(0, left).trim();
			const second = normalized.slice(left).trim();
			if (first !== "" && second !== "") {
				return [first, second];
			}
		}
	}

	if (normalized.length < 2) return null;
	const fallbackMidpoint = Math.max(1, midpoint);
	const first = normalized.slice(0, fallbackMidpoint).trim();
	const second = normalized.slice(fallbackMidpoint).trim();
	return first !== "" && second !== "" ? [first, second] : null;
}

function splitSingleMarkdownTableRowContent(
	headers: string[],
	row: string[],
): [string, string] | null {
	if (headers.length < 2 || row.length === 0) return null;

	const label = row[0] ?? "";
	const firstRow = [label];
	const secondRow = [label];
	let movedContent = false;

	for (let index = 1; index < headers.length; index += 1) {
		const cell = row[index] ?? "";
		const splitCell = splitMarkdownContent(cell);
		if (splitCell !== null) {
			firstRow.push(splitCell[0]);
			secondRow.push(splitCell[1]);
			movedContent = true;
			continue;
		}

		firstRow.push(cell);
		secondRow.push("");
	}

	if (!movedContent) {
		let longestIndex = -1;
		let longestLength = 0;
		for (let index = 1; index < headers.length; index += 1) {
			const cellLength = (row[index] ?? "").trim().length;
			if (cellLength > longestLength) {
				longestIndex = index;
				longestLength = cellLength;
			}
		}

		if (longestIndex === -1) return null;
		const splitCell = splitMarkdownContent(row[longestIndex] ?? "");
		if (splitCell === null) return null;
		firstRow[longestIndex] = splitCell[0];
		secondRow[longestIndex] = splitCell[1];
		movedContent = true;
	}

	if (!movedContent) return null;
	if (!secondRow.slice(1).some((cell) => cell.trim() !== "")) return null;

	return [
		buildMarkdownTable(headers, [firstRow]),
		buildMarkdownTable(headers, [secondRow]),
	];
}

export function splitOversizedMarkdownTableSource(text: string): string[] | null {
	const table = findLargestMarkdownTableBlock(text);
	if (table === null) return null;

	const headers = splitMarkdownTableRow(table.header);
	const parsedRows = table.rows.map((row) => splitMarkdownTableRow(row));
	if (headers.length < 2 || parsedRows.length === 0) return null;

	let firstTable: string | null = null;
	let secondTable: string | null = null;

	if (parsedRows.length >= 2) {
		const midpoint = Math.ceil(parsedRows.length / 2);
		firstTable = buildMarkdownTable(headers, parsedRows.slice(0, midpoint));
		secondTable = buildMarkdownTable(headers, parsedRows.slice(midpoint));
	} else if (headers.length >= 5) {
		const sharedHeader = headers[0] ?? "";
		const otherHeaders = headers.slice(1);
		const midpoint = Math.ceil(otherHeaders.length / 2);
		if (midpoint < 2 || otherHeaders.length - midpoint < 2) return null;

		const row = parsedRows[0] ?? [];
		const firstHeaders = [sharedHeader, ...otherHeaders.slice(0, midpoint)];
		const secondHeaders = [sharedHeader, ...otherHeaders.slice(midpoint)];
		const firstRow = [row[0] ?? "", ...row.slice(1, midpoint + 1)];
		const secondRow = [row[0] ?? "", ...row.slice(midpoint + 1)];

		firstTable = buildMarkdownTable(firstHeaders, [firstRow]);
		secondTable = buildMarkdownTable(secondHeaders, [secondRow]);
	} else {
		const splitRowTables = splitSingleMarkdownTableRowContent(
			headers,
			parsedRows[0] ?? [],
		);
		if (splitRowTables === null) return null;
		[firstTable, secondTable] = splitRowTables;
	}

	if (firstTable === null || secondTable === null) return null;
	const before = text.slice(0, table.start).replace(/[ \t]*$/, "");
	const after = text.slice(table.end).replace(/^[ \t\r\n]*/, "");

	const firstPart =
		`${before}${before === "" ? "" : "\n\n"}${firstTable}`.trim();
	const secondPart =
		`${secondTable}${after === "" ? "" : "\n\n"}${after}`.trim();

	if (firstPart === "" || secondPart === "") return null;
	return [firstPart, secondPart];
}

// --- HTML escaping ---

export function escapeTelegramHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeTelegramHtmlAttribute(text: string): string {
	return escapeTelegramHtml(text).replaceAll('"', "&quot;");
}

// --- Markdown-it configuration ---

function getTelegramListStack(
	env: TelegramMarkdownRenderEnv,
): TelegramListState[] {
	env.telegramLists ??= [];
	return env.telegramLists;
}

function getTelegramListIndent(env: TelegramMarkdownRenderEnv): string {
	const depth = Math.max(getTelegramListStack(env).length - 1, 0);
	return "  ".repeat(depth);
}

function normalizeTelegramLanguage(language: string): string {
	const normalized = language.trim().toLowerCase();
	if (normalized === "") return "";
	return /^[a-z0-9_+-]+$/i.test(normalized) ? normalized : "";
}

const telegramMarkdown = new MarkdownIt({
	breaks: false,
	html: false,
	linkify: true,
	typographer: false,
});
telegramMarkdown.disable(["table"]);

telegramMarkdown.renderer.rules.paragraph_open = () => "";
telegramMarkdown.renderer.rules.paragraph_close = (tokens, idx) => {
	if (tokens[idx]?.hidden) return "";
	const nextTokenType = tokens[idx + 1]?.type ?? "";
	return nextTokenType === "blockquote_close" ? "" : "\n\n";
};
telegramMarkdown.renderer.rules.heading_open = () => "<b>";
telegramMarkdown.renderer.rules.heading_close = () => "</b>\n\n";
telegramMarkdown.renderer.rules.strong_open = () => "<b>";
telegramMarkdown.renderer.rules.strong_close = () => "</b>";
telegramMarkdown.renderer.rules.em_open = () => "<i>";
telegramMarkdown.renderer.rules.em_close = () => "</i>";
telegramMarkdown.renderer.rules.s_open = () => "<s>";
telegramMarkdown.renderer.rules.s_close = () => "</s>";
telegramMarkdown.renderer.rules.softbreak = () => "\n";
telegramMarkdown.renderer.rules.hardbreak = () => "\n";
telegramMarkdown.renderer.rules.link_open = (tokens, idx) => {
	const href = tokens[idx]?.attrGet("href") ?? "";
	return `<a href="${escapeTelegramHtmlAttribute(href)}">`;
};
telegramMarkdown.renderer.rules.link_close = () => "</a>";
telegramMarkdown.renderer.rules.code_inline = (tokens, idx) =>
	`<code>${escapeTelegramHtml(tokens[idx]?.content ?? "")}</code>`;
telegramMarkdown.renderer.rules.code_block = (tokens, idx) =>
	`<pre><code>${escapeTelegramHtml(tokens[idx]?.content ?? "")}</code></pre>\n\n`;
telegramMarkdown.renderer.rules.fence = (tokens, idx) => {
	const token = tokens[idx];
	const info = token?.info ?? "";
	const language = normalizeTelegramLanguage(info.split(/\s+/, 1)[0] ?? "");
	const className = language === "" ? "" : ` class="language-${language}"`;
	return `<pre><code${className}>${escapeTelegramHtml(token?.content ?? "")}</code></pre>\n\n`;
};
telegramMarkdown.renderer.rules.bullet_list_open = (
	_tokens,
	_idx,
	_options,
	env,
) => {
	getTelegramListStack(env as TelegramMarkdownRenderEnv).push({
		type: "bullet",
	});
	return "";
};
telegramMarkdown.renderer.rules.bullet_list_close = (
	_tokens,
	_idx,
	_options,
	env,
) => {
	getTelegramListStack(env as TelegramMarkdownRenderEnv).pop();
	return "\n";
};
telegramMarkdown.renderer.rules.ordered_list_open = (
	tokens,
	idx,
	_options,
	env,
) => {
	const start = Number(tokens[idx]?.attrGet("start") ?? "1");
	getTelegramListStack(env as TelegramMarkdownRenderEnv).push({
		type: "ordered",
		next: Number.isFinite(start) ? start : 1,
	});
	return "";
};
telegramMarkdown.renderer.rules.ordered_list_close = (
	_tokens,
	_idx,
	_options,
	env,
) => {
	getTelegramListStack(env as TelegramMarkdownRenderEnv).pop();
	return "\n";
};
telegramMarkdown.renderer.rules.list_item_open = (
	_tokens,
	_idx,
	_options,
	env,
) => {
	const renderEnv = env as TelegramMarkdownRenderEnv;
	const stack = getTelegramListStack(renderEnv);
	const currentList = stack.at(-1);
	const indent = getTelegramListIndent(renderEnv);

	if (!currentList || currentList.type === "bullet") {
		return `${indent}• `;
	}

	const prefix = `${currentList.next}. `;
	currentList.next += 1;
	return `${indent}${prefix}`;
};
telegramMarkdown.renderer.rules.list_item_close = () => "\n";
telegramMarkdown.renderer.rules.blockquote_open = () => "<blockquote>";
telegramMarkdown.renderer.rules.blockquote_close = () => "</blockquote>\n\n";
telegramMarkdown.renderer.rules.hr = () => "----------\n\n";
telegramMarkdown.renderer.rules.image = (tokens, idx) => {
	const token = tokens[idx];
	return escapeTelegramHtml(token?.content || token?.attrGet("src") || "");
};

// --- Table rendering ---

function renderTelegramInline(text: string): string {
	return telegramMarkdown.renderInline(text).trim();
}

function normalizeTelegramInlineSource(text: string): string {
	return text.replace(/<br\s*\/?>/gi, "\n");
}

function renderTelegramBoldInline(text: string): string {
	const rendered = renderTelegramInline(normalizeTelegramInlineSource(text));
	if (rendered === "") return "";
	return rendered.includes("<b>") ? rendered : `<b>${rendered}</b>`;
}

function renderTelegramInlineLines(text: string): string[] {
	return normalizeTelegramInlineSource(text)
		.split("\n")
		.map((line) => renderTelegramInline(line.trim()))
		.filter((line) => line !== "");
}

function renderTelegramTable(tableLines: string[]): string {
	if (tableLines.length < 2) {
		return `<pre><code>${escapeTelegramHtml(tableLines.join("\n"))}</code></pre>`;
	}

	const headers = splitMarkdownTableRow(tableLines[0] ?? "");
	const rows = tableLines
		.slice(2)
		.map((line) => splitMarkdownTableRow(line))
		.filter((row) => row.some((cell) => cell !== ""));

	if (headers.length < 2 || rows.length === 0) {
		return `<pre><code>${escapeTelegramHtml(tableLines.join("\n"))}</code></pre>`;
	}

	return rows
		.map((row, rowIndex) => {
			const labelSource = row[0] || `${headers[0] || "Row"} ${rowIndex + 1}`;
			const label = renderTelegramBoldInline(labelSource);

			if (headers.length === 2) {
				const valueLines = renderTelegramInlineLines(row[1] ?? "");
				if (valueLines.length === 0) return label;
				if (valueLines.length === 1) return `${label}: ${valueLines[0]}`;
				return `${label}: ${valueLines[0]}\n${valueLines
					.slice(1)
					.map((line) => `  ${line}`)
					.join("\n")}`;
			}

			const details = headers
				.slice(1)
				.map((header, columnIndex) => {
					const valueLines = renderTelegramInlineLines(
						row[columnIndex + 1] ?? "",
					);
					if (valueLines.length === 0) return null;
					const headerLabel = renderTelegramBoldInline(header);
					if (valueLines.length === 1) {
						return `• ${headerLabel}: ${valueLines[0]}`;
					}
					return `• ${headerLabel}: ${valueLines[0]}\n${valueLines
						.slice(1)
						.map((line) => `  ${line}`)
						.join("\n")}`;
				})
				.filter((line): line is string => line !== null);

			if (details.length === 0) return label;
			return `${label}\n${details.join("\n")}`;
		})
		.join("\n\n");
}

// --- Preprocessing ---

function preprocessTelegramMarkdown(text: string): {
	markdown: string;
	tablePlaceholders: Map<string, string>;
} {
	const lines = text.split("\n");
	const output: string[] = [];
	const tablePlaceholders = new Map<string, string>();
	let tableIndex = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const nextLine = lines[index + 1] ?? "";

		if (
			looksLikeMarkdownTableHeader(line) &&
			isMarkdownTableSeparator(nextLine)
		) {
			const tableLines = [line, nextLine];
			let cursor = index + 2;
			while (
				cursor < lines.length &&
				looksLikeMarkdownTableRow(lines[cursor] ?? "")
			) {
				tableLines.push(lines[cursor] ?? "");
				cursor += 1;
			}

			const placeholder = `@@TELEGRAM_TABLE_${tableIndex}@@`;
			tableIndex += 1;
			tablePlaceholders.set(placeholder, renderTelegramTable(tableLines));
			output.push(placeholder);
			index = cursor - 1;
			continue;
		}

		output.push(line);
	}

	return {
		markdown: output.join("\n"),
		tablePlaceholders,
	};
}

// --- Public API ---

export function renderTelegramHtml(text: string): string {
	const { markdown, tablePlaceholders } = preprocessTelegramMarkdown(text);
	let rendered = telegramMarkdown.render(markdown).trimEnd();

	for (const [placeholder, tableHtml] of tablePlaceholders) {
		rendered = rendered.replaceAll(placeholder, tableHtml);
	}

	return rendered;
}

export function renderTelegramCaptionHtml(text: string): string | null {
	const rendered = renderTelegramHtml(text).trim();
	return rendered === "" ? null : rendered;
}
