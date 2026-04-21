import { extname } from "node:path";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import MarkdownIt from "markdown-it";
import {
	VOICE_MAX_BYTES,
	VOICE_MIME_TYPE,
} from "../capabilities/voice/constants";
import {
	buildVoiceContent,
	buildVoiceTurnText,
} from "../capabilities/voice/content";
import { fetchVoiceBytes } from "../capabilities/voice/fetch";
import { OpenRouterTranscriber } from "../capabilities/voice/openrouter_transcriber";
import {
	NoOpTranscriber,
	type Transcriber,
} from "../capabilities/voice/transcriber";
import { WhisperTranscriber } from "../capabilities/voice/whisper_transcriber";
import {
	PDF_MAX_BYTES,
} from "../capabilities/pdf/constants";
import { buildPdfContent, buildPdfText } from "../capabilities/pdf/content";
import {
	type PdfExtractor,
	NoOpPdfExtractor,
} from "../capabilities/pdf/extractor";
import { PdfExtractExtractor } from "../capabilities/pdf/pdf_extract_extractor";
import type { AppConfig } from "../config";
import { createDb, detectDialect } from "../db/index";
import { readThreadMessages } from "../memory/rotate_thread";
import {
	type ApprovalBroker,
	type ApprovalOutcome,
	type ApprovalRequest,
	persistAlwaysRule,
} from "../permissions/approval";
import { maybeHandleCommand } from "../permissions/commands";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import { basenameFromPath } from "../utils/filesystem";
import type {
	OutboundChannel,
	OutboundSendFileArgs,
	OutboundSendResult,
} from "./outbound";
import { maybeHandleSessionCommand } from "./session_commands";
import {
	buildInvokeMessages,
	type ChannelAgentSession,
	clearPendingCompactionSeed,
	clearPendingTaskCheckContext,
	createChannelAgentSession,
	extractAgentReply,
	extractTextFromContent,
	maybeAutoCompactAndSeed,
	maybeResumeCompactAndSeed,
	maybeRunPendingTaskCheck,
} from "./shared";
import type { AppChannel, ChannelRunOptions } from "./types";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
const APPROVAL_TIMEOUT_MS = 120_000;
const TELEGRAM_HTML_PARSE_MODE = "HTML";
const TELEGRAM_TYPING_INTERVAL_MS = 4_000;
const TELEGRAM_STREAM_PARAGRAPH_FLUSH_INTERVAL_MS = 2_500;
const TELEGRAM_STREAM_CHUNK_MIN_LENGTH = 240;
const TELEGRAM_STREAM_CHUNK_TARGET_LENGTH = 900;
const TELEGRAM_STREAM_CHUNK_HARD_LENGTH = 1_600;
const TELEGRAM_STREAM_DEFAULT_BOUNDARY_PATTERNS = [
	/\n\n/g,
	/\n/g,
	/[.!?](?:\s|$)/g,
	/[;:](?:\s|$)/g,
	/, /g,
	/ /g,
] as const;
const TELEGRAM_STREAM_PARAGRAPH_BOUNDARY_PATTERNS = [/\n\s*\n/g] as const;
const TELEGRAM_STREAM_OVERFLOW_BOUNDARY_PATTERNS = [
	/\n\s*\n/g,
	/\n/g,
	/\s+/g,
] as const;
const TELEGRAM_COMMANDS = [
	{ command: "help", description: "Show available permission commands" },
	{ command: "policy", description: "Show your current permission rules" },
	{ command: "allow", description: "Always allow a tool" },
	{ command: "deny", description: "Always deny a tool" },
	{ command: "ask", description: "Forget a saved tool rule" },
	{ command: "reset", description: "Clear all your permission rules" },
	{ command: "new_thread", description: "Start a fresh conversation thread" },
	{ command: "open_fs", description: "Open your files in a web browser" },
	{ command: "revoke_fs", description: "Revoke all active file-share links" },
] as const;

type PendingApproval = {
	request: ApprovalRequest;
	resolve: (outcome: ApprovalOutcome) => Promise<void>;
	timeout: NodeJS.Timeout;
	promptId: string;
};

type TelegramAgentSession = ChannelAgentSession & {
	running: boolean;
	queue: TelegramQueuedTurn[];
	pendingApprovals: Map<string, PendingApproval>;
	transcriber: Transcriber;
	pdfExtractor: PdfExtractor;
};

type TelegramTextContentBlock = {
	type: "text";
	text: string;
};

type TelegramImageContentBlock = {
	type: "image";
	mimeType: string;
	data: Uint8Array;
};

type TelegramUserInput =
	| string
	| Array<TelegramTextContentBlock | TelegramImageContentBlock>;

type TelegramQueuedTurn = {
	content: TelegramUserInput;
	commandText: string;
	currentUserText?: string;
};

type TelegramVoiceFile = {
	file_size?: number;
};

type TelegramDocumentFile = {
	file_size?: number;
};

type TelegramListState = { type: "bullet" } | { type: "ordered"; next: number };

type TelegramMarkdownRenderEnv = {
	telegramLists?: TelegramListState[];
};

type MarkdownTableBlock = {
	start: number;
	end: number;
	header: string;
	separator: string;
	rows: string[];
};

type TrailingMarkdownTableContext = {
	start: number;
	header: string;
	separator: string;
	rows: string[];
};

type TelegramMarkdownChunkContext = {
	openDelimiters: string[];
	inCodeFence: boolean;
	inInlineCode: boolean;
	trailingTable: TrailingMarkdownTableContext | null;
};

export const chunkTelegramMessage = (text: string): string[] => {
	return chunkTelegramText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
};

function scanTelegramMarkdownChunkContext(
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

function hasOpenTelegramMarkdownStructures(
	context: TelegramMarkdownChunkContext,
): boolean {
	return (
		context.inCodeFence ||
		context.inInlineCode ||
		context.openDelimiters.length > 0
	);
}

function isSafeTelegramMarkdownChunk(text: string): boolean {
	const context = scanTelegramMarkdownChunkContext(text);
	return (
		!hasOpenTelegramMarkdownStructures(context) &&
		context.trailingTable === null
	);
}

function findTelegramStreamBoundary(
	text: string,
	maxLength: number,
	options?: {
		minLength?: number;
		boundaryPatterns?: readonly RegExp[];
	},
): number | null {
	const limited = text.slice(0, maxLength);
	const minLength = options?.minLength ?? TELEGRAM_STREAM_CHUNK_MIN_LENGTH;
	const boundaryPatterns =
		options?.boundaryPatterns ?? TELEGRAM_STREAM_DEFAULT_BOUNDARY_PATTERNS;
	let boundary: number | null = null;

	for (const sourcePattern of boundaryPatterns) {
		const pattern = new RegExp(sourcePattern.source, sourcePattern.flags);
		let match: RegExpExecArray | null = null;
		while (true) {
			const nextMatch = pattern.exec(limited);
			if (nextMatch === null) break;
			match = nextMatch;
		}
		if (match !== null) {
			const matchText = match[0] ?? "";
			const candidate = match.index + matchText.length;
			if (candidate >= minLength) {
				boundary = Math.max(boundary ?? 0, candidate);
				break;
			}
		}
	}

	return boundary;
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

export function takeTelegramStreamChunks(
	text: string,
	isFinal = false,
	options?: {
		minLength?: number;
		targetLength?: number;
		hardLength?: number;
		boundaryPatterns?: readonly RegExp[];
		requireBoundary?: boolean;
	},
): { chunks: string[]; remainder: string } {
	if (isFinal) {
		const finalChunk = text.trim();
		return {
			chunks: finalChunk === "" ? [] : [finalChunk],
			remainder: "",
		};
	}

	const chunks: string[] = [];
	let remainder = text;
	const minLength = options?.minLength ?? TELEGRAM_STREAM_CHUNK_MIN_LENGTH;
	const targetLength =
		options?.targetLength ?? TELEGRAM_STREAM_CHUNK_TARGET_LENGTH;
	const hardLength = options?.hardLength ?? TELEGRAM_STREAM_CHUNK_HARD_LENGTH;
	const boundaryPatterns =
		options?.boundaryPatterns ?? TELEGRAM_STREAM_DEFAULT_BOUNDARY_PATTERNS;
	const requireBoundary = options?.requireBoundary ?? false;

	while (remainder !== "") {
		if (!isFinal && remainder.length < minLength) break;

		const preferredBoundary = findTelegramStreamBoundary(
			remainder,
			Math.min(remainder.length, targetLength),
			{
				minLength,
				boundaryPatterns,
			},
		);
		let boundary = preferredBoundary;

		if (boundary === null) {
			if (!isFinal && requireBoundary) break;
			if (!isFinal && remainder.length < hardLength) break;
			boundary =
				findTelegramStreamBoundary(
					remainder,
					Math.min(remainder.length, hardLength),
					{
						minLength,
						boundaryPatterns,
					},
				) ?? Math.min(remainder.length, hardLength);
		}

		const candidate = remainder.slice(0, boundary);
		const candidateContext = scanTelegramMarkdownChunkContext(candidate);
		const trailingTable = candidateContext.trailingTable;
		if (trailingTable !== null) {
			if (trailingTable.start === 0) break;
			const prefixCandidate = candidate.slice(0, trailingTable.start);
			const prefixContext = scanTelegramMarkdownChunkContext(prefixCandidate);
			if (hasOpenTelegramMarkdownStructures(prefixContext)) break;
			const prefixChunk = prefixCandidate.trimEnd();
			if (prefixChunk === "") break;
			chunks.push(prefixChunk);
			remainder = remainder
				.slice(trailingTable.start)
				.replace(/^[ \t\r\n]+/, "");
			continue;
		}
		if (hasOpenTelegramMarkdownStructures(candidateContext)) break;

		const chunk = candidate.trimEnd();
		if (chunk === "") break;
		chunks.push(chunk);
		remainder = remainder.slice(boundary).replace(/^[ \t\r\n]+/, "");
	}

	return { chunks, remainder };
}

export function takeTelegramParagraphStreamChunks(text: string): {
	chunks: string[];
	remainder: string;
} {
	let boundary: number | null = null;

	for (const sourcePattern of TELEGRAM_STREAM_PARAGRAPH_BOUNDARY_PATTERNS) {
		const pattern = new RegExp(sourcePattern.source, sourcePattern.flags);
		while (true) {
			const nextMatch = pattern.exec(text);
			if (nextMatch === null) break;
			const candidate = nextMatch.index + (nextMatch[0] ?? "").length;
			const prefix = text.slice(0, candidate);
			const suffix = text.slice(candidate);
			if (isLikelyTelegramCompletedParagraph(prefix, suffix)) {
				boundary = candidate;
			}
		}
	}

	if (boundary === null) {
		return { chunks: [], remainder: text };
	}

	const candidate = text.slice(0, boundary);
	const candidateContext = scanTelegramMarkdownChunkContext(candidate);
	if (
		hasOpenTelegramMarkdownStructures(candidateContext) ||
		candidateContext.trailingTable !== null
	) {
		return { chunks: [], remainder: text };
	}

	const chunk = candidate.trimEnd();
	if (chunk === "") return { chunks: [], remainder: text };

	return {
		chunks: [chunk],
		remainder: text.slice(boundary).replace(/^[ \t\r\n]+/, ""),
	};
}

function findSafeTelegramOverflowBoundary(
	text: string,
	maxLength: number,
	minLength = 1,
): number | null {
	const limitedMaxLength = Math.min(text.length, maxLength);

	for (let boundary = limitedMaxLength; boundary >= minLength; boundary -= 1) {
		const previousCharacter = text[boundary - 1] ?? "";
		const nextCharacter = text[boundary] ?? "";
		if (!/\s/.test(previousCharacter) && !/\s/.test(nextCharacter)) continue;

		const candidate = text.slice(0, boundary);
		const chunk = candidate.trimEnd();
		if (chunk === "") continue;
		if (!isSafeTelegramMarkdownChunk(candidate)) continue;
		return boundary;
	}

	return null;
}

export function takeTelegramOverflowStreamChunks(text: string): {
	chunks: string[];
	remainder: string;
} {
	if (text.trim() === "") return { chunks: [], remainder: "" };
	if (renderTelegramHtml(text).length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
		return { chunks: [], remainder: text };
	}

	const preferredSplit = takeTelegramStreamChunks(text, false, {
		minLength: 1,
		targetLength: TELEGRAM_STREAM_CHUNK_HARD_LENGTH,
		hardLength: TELEGRAM_STREAM_CHUNK_HARD_LENGTH,
		boundaryPatterns: TELEGRAM_STREAM_OVERFLOW_BOUNDARY_PATTERNS,
		requireBoundary: true,
	});
	if (preferredSplit.chunks.length > 0) {
		return preferredSplit;
	}

	const safeBoundary = findSafeTelegramOverflowBoundary(
		text,
		TELEGRAM_STREAM_CHUNK_HARD_LENGTH,
	);
	if (safeBoundary === null) return { chunks: [], remainder: text };

	const chunk = text.slice(0, safeBoundary).trimEnd();
	if (chunk === "") return { chunks: [], remainder: text };

	return {
		chunks: [chunk],
		remainder: text.slice(safeBoundary).replace(/^[ \t\r\n]+/, ""),
	};
}

function isLikelyTelegramCompletedParagraph(
	prefix: string,
	suffix: string,
): boolean {
	const normalizedPrefix = prefix.trimEnd();
	if (normalizedPrefix === "") return false;
	if (/[.!?…][\]")'`]*$/.test(normalizedPrefix)) return true;

	const normalizedSuffix = suffix.trimStart();
	if (normalizedSuffix === "") return true;

	return /^(?:[-*•]\s|\d+\.\s|>\s|#{1,6}\s|```|\|)/.test(normalizedSuffix);
}

function chunkTelegramText(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) return [text];
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		const remaining = text.length - start;
		if (remaining <= maxLength) {
			chunks.push(text.slice(start));
			break;
		}

		const maxEnd = start + maxLength;
		const window = text.slice(start, maxEnd);
		const preferredBreaks = ["\n\n", "\n", " "];
		let end = maxEnd;

		for (const separator of preferredBreaks) {
			const index = window.lastIndexOf(separator);
			if (index >= maxLength / 2) {
				end = start + index + separator.length;
				break;
			}
		}

		chunks.push(text.slice(start, end));
		start = end;
	}
	return chunks;
}

function escapeTelegramHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeTelegramHtmlAttribute(text: string): string {
	return escapeTelegramHtml(text).replaceAll('"', "&quot;");
}

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

function splitOversizedMarkdownTableSource(text: string): string[] | null {
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

export function chunkRenderedTelegramMessages(text: string): string[] {
	const pendingSources = [text];
	const renderedChunks: string[] = [];

	while (pendingSources.length > 0) {
		const source = pendingSources.shift();
		if (source === undefined) break;

		const rendered = renderTelegramHtml(source);
		if (rendered.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
			if (rendered.trim() !== "") {
				renderedChunks.push(rendered);
			}
			continue;
		}

		const tableSplitSources = splitOversizedMarkdownTableSource(source);
		if (tableSplitSources !== null) {
			pendingSources.unshift(...tableSplitSources);
			continue;
		}

		const nextMaxLength = Math.max(1, Math.floor(source.length / 2));
		const splitSources = chunkTelegramText(source, nextMaxLength);

		if (splitSources.length <= 1) {
			const midpoint = Math.max(1, Math.floor(source.length / 2));
			pendingSources.unshift(source.slice(0, midpoint), source.slice(midpoint));
			continue;
		}

		pendingSources.unshift(...splitSources);
	}

	return renderedChunks;
}

function findTelegramTextOverlap(previous: string, next: string): number {
	const maxOverlap = Math.min(previous.length, next.length);
	for (let length = maxOverlap; length > 0; length -= 1) {
		if (previous.slice(-length) === next.slice(0, length)) {
			return length;
		}
	}
	return 0;
}

export function mergeTelegramStreamText(
	previous: string,
	next: string,
): { fullText: string; delta: string } {
	if (next === "") return { fullText: previous, delta: "" };
	if (previous === "") return { fullText: next, delta: next };
	if (next.startsWith(previous)) {
		return {
			fullText: next,
			delta: next.slice(previous.length),
		};
	}
	if (previous.endsWith(next)) {
		return {
			fullText: previous,
			delta: "",
		};
	}

	const overlap = findTelegramTextOverlap(previous, next);
	const delta = next.slice(overlap);
	return {
		fullText: previous + delta,
		delta,
	};
}

export function extractTelegramCommandName(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const firstSpace = trimmed.indexOf(" ");
	const rawCommand = (
		firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
	)
		.slice(1)
		.toLowerCase();
	const command = rawCommand.split("@", 1)[0] ?? "";
	return command === "" ? null : command;
}

async function syncTelegramCommands(bot: Bot): Promise<void> {
	await bot.api.setMyCommands([...TELEGRAM_COMMANDS]);
}

export function formatUnknownTelegramCommandReply(command: string): string {
	const knownCommands = TELEGRAM_COMMANDS.map(
		({ command: knownCommand }) => `/${knownCommand}`,
	).join(", ");
	return `Unknown command: /${command}\nAvailable commands: ${knownCommands}`;
}

export async function getTelegramCaller(
	store: PermissionsStore,
	chatId: string,
): Promise<Caller | null> {
	const user = await store.getUser("telegram", chatId);
	if (!user || user.status === "suspended") return null;
	return {
		id: user.id,
		entrypoint: "telegram",
		externalId: user.externalId,
		displayName: user.displayName ?? undefined,
	};
}

async function sendTelegramMessage(
	bot: Bot,
	chatId: string,
	text: string,
	options: Record<string, unknown> = {},
): Promise<void> {
	for (const chunk of chunkRenderedTelegramMessages(text)) {
		await bot.api.sendMessage(chatId, chunk, {
			parse_mode: TELEGRAM_HTML_PARSE_MODE,
			...options,
		});
	}
}

async function sendTelegramTyping(bot: Bot, chatId: string): Promise<void> {
	await bot.api.sendChatAction(chatId, "typing").catch(() => undefined);
}

export class TelegramOutboundChannel implements OutboundChannel {
	constructor(
		private readonly bot: Bot,
		private readonly resolveChatId: (callerId: string) => string | null,
	) {}

	async sendFile(args: OutboundSendFileArgs): Promise<OutboundSendResult> {
		const chatId = this.resolveChatId(args.callerId);
		if (!chatId) {
			return {
				ok: false,
				error: `No active telegram chat for caller '${args.callerId}'.`,
			};
		}

		const filename = basenameFromPath(args.path) || "file";
		const buffer = Buffer.from(
			args.bytes.buffer,
			args.bytes.byteOffset,
			args.bytes.byteLength,
		);

		try {
			const caption =
				typeof args.caption === "string" && args.caption !== ""
					? renderTelegramCaptionHtml(args.caption)
					: null;
			if (caption !== null && caption.length > TELEGRAM_MAX_CAPTION_LENGTH) {
				return {
					ok: false,
					error: `Rendered caption is too long (${caption.length} chars). Telegram captions are limited to ${TELEGRAM_MAX_CAPTION_LENGTH} characters after formatting.`,
				};
			}

			await this.bot.api.sendDocument(chatId, new InputFile(buffer, filename), {
				caption: caption ?? undefined,
				parse_mode: caption ? TELEGRAM_HTML_PARSE_MODE : undefined,
			});
			return { ok: true };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "unknown telegram error";
			return { ok: false, error: message };
		}
	}
}

function startTelegramTypingLoop(bot: Bot, chatId: string): () => void {
	void sendTelegramTyping(bot, chatId);
	const timer = setInterval(() => {
		void sendTelegramTyping(bot, chatId);
	}, TELEGRAM_TYPING_INTERVAL_MS);

	return () => {
		clearInterval(timer);
	};
}

function extractTelegramStreamText(message: unknown): string {
	if (
		typeof message !== "object" ||
		message === null ||
		!("getType" in message) ||
		typeof message.getType !== "function" ||
		message.getType() !== "ai"
	) {
		return "";
	}

	if (
		"text" in message &&
		typeof message.text === "string" &&
		message.text !== ""
	) {
		return message.text;
	}

	if ("content" in message) {
		return extractTextFromContent(message.content);
	}

	return "";
}

function normalizeTelegramCommandText(text: string | null | undefined): string {
	return typeof text === "string" ? text.trim() : "";
}

function detectTelegramImageMimeType(filePath: string | undefined): string {
	switch (extname(filePath ?? "").toLowerCase()) {
		case ".png":
			return "image/png";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".bmp":
			return "image/bmp";
		default:
			return "image/jpeg";
	}
}

export function buildTelegramPhotoContent(
	imageData: Uint8Array,
	options?: {
		caption?: string | null;
		filePath?: string;
	},
): Array<TelegramTextContentBlock | TelegramImageContentBlock> {
	const caption = normalizeTelegramCommandText(options?.caption);

	return [
		{
			type: "text",
			text:
				caption === "" ? "User attached an image without a caption." : caption,
		},
		{
			type: "image",
			mimeType: detectTelegramImageMimeType(options?.filePath),
			data: imageData,
		},
	];
}

export async function fetchTelegramFileBytes(
	file: { file_path?: string },
	botToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ data: Uint8Array; filePath: string }> {
	const filePath = file.file_path;
	if (typeof filePath !== "string" || filePath === "") {
		throw new Error("Telegram did not return a downloadable file path.");
	}

	const response = await fetchImpl(
		`https://api.telegram.org/file/bot${botToken}/${filePath}`,
	);
	if (!response.ok) {
		throw new Error(
			`Telegram file download failed with status ${response.status}.`,
		);
	}

	return {
		data: new Uint8Array(await response.arrayBuffer()),
		filePath,
	};
}

function summarizeArgs(args: unknown): string {
	try {
		const json = JSON.stringify(args);
		if (json.length <= 180) return json;
		return `${json.slice(0, 177)}...`;
	} catch {
		return String(args);
	}
}

export function extractTelegramReplyFromAgentState(state: unknown): string {
	if (
		typeof state !== "object" ||
		state === null ||
		!("values" in state) ||
		typeof state.values !== "object" ||
		state.values === null
	) {
		return "";
	}

	const reply = extractAgentReply(
		state.values as { messages?: Array<{ content?: unknown }> },
	);
	return reply ===
		"The agent completed the task but did not return a text response."
		? ""
		: reply;
}

async function getTelegramFinalAgentReply(
	session: TelegramAgentSession,
): Promise<string> {
	try {
		const state = await session.agent.getState({
			configurable: { thread_id: session.threadId },
		});
		return extractTelegramReplyFromAgentState(state);
	} catch {
		return "";
	}
}

class TelegramApprovalBroker implements ApprovalBroker {
	constructor(
		private readonly bot: Bot,
		private readonly sessions: Map<string, TelegramAgentSession>,
		private readonly chatId: string,
		private readonly store: PermissionsStore,
	) {}

	async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
		const session = this.sessions.get(this.chatId);
		if (!session) return "deny-once";

		const promptId = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
		const summary = summarizeArgs(request.args);
		const text = `Approve tool call?\n${request.toolName}(${summary})`;
		const keyboard = new InlineKeyboard()
			.text("Approve", `approve-once:${promptId}`)
			.text("Always allow", `approve-always:${promptId}`)
			.row()
			.text("Deny", `deny-once:${promptId}`)
			.text("Always deny", `deny-always:${promptId}`);

		await sendTelegramMessage(this.bot, this.chatId, text, {
			reply_markup: keyboard,
		});

		return await new Promise<ApprovalOutcome>((resolve) => {
			const timeout = setTimeout(() => {
				if (session.pendingApprovals.has(promptId)) {
					session.pendingApprovals.delete(promptId);
					resolve("deny-once");
				}
			}, APPROVAL_TIMEOUT_MS);

			const wrappedResolve = async (outcome: ApprovalOutcome) => {
				clearTimeout(timeout);
				if (outcome === "approve-always" || outcome === "deny-always") {
					await persistAlwaysRule(
						this.store,
						request.caller,
						request.toolName,
						request.args,
						outcome === "approve-always" ? "allow" : "deny",
					);
				}
				resolve(outcome);
			};

			session.pendingApprovals.set(promptId, {
				request,
				resolve: wrappedResolve,
				timeout,
				promptId,
			});
		});
	}
}

export function createTelegramTranscriber(config: AppConfig): Transcriber {
	if (config.enableVoiceMessages === false) {
		return new NoOpTranscriber();
	}

	switch (config.transcriptionProvider) {
		case "openai":
			return new WhisperTranscriber({
				apiKey: config.transcriptionApiKey,
				baseUrl: config.transcriptionBaseUrl || undefined,
			});
		case "openrouter":
			return new OpenRouterTranscriber({
				apiKey: config.transcriptionApiKey,
				baseUrl: config.transcriptionBaseUrl || undefined,
			});
	}
}

export async function ensureTelegramSession(
	chatId: string,
	caller: Caller,
	config: AppConfig,
	db: InstanceType<typeof Bun.SQL>,
	dialect: "sqlite" | "postgres",
	store: PermissionsStore,
	bot: Bot,
	sessions: Map<string, TelegramAgentSession>,
	outbound: OutboundChannel,
	webShare: ChannelRunOptions["webShare"],
	transcriber: Transcriber,
	pdfExtractor: PdfExtractor,
): Promise<TelegramAgentSession> {
	const existing = sessions.get(chatId);
	if (existing) return existing;

	const broker = new TelegramApprovalBroker(bot, sessions, chatId, store);
	const baseThreadId = `telegram-${chatId}`;
	const session = await createChannelAgentSession(config, {
		db,
		dialect,
		caller,
		store,
		broker,
		threadId: baseThreadId,
		outbound,
		webShare,
	});

	const telegramSession: TelegramAgentSession = {
		...session,
		running: false,
		queue: [],
		pendingApprovals: new Map(),
		transcriber,
		pdfExtractor,
	};
	sessions.set(chatId, telegramSession);
	return telegramSession;
}

function mintTelegramThreadId(chatId: string): string {
	return `telegram-${chatId}-${Date.now()}`;
}

async function runAgentTurn(
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
	queuedTurn: TelegramQueuedTurn,
): Promise<void> {
	const stopTyping = startTelegramTypingLoop(bot, chatId);
	try {
		session.currentUserText =
			queuedTurn.currentUserText ?? extractTextFromContent(queuedTurn.content);
		await session.refreshAgent();
		const currentMessages = await readThreadMessages(
			session.agent,
			session.threadId,
		);
		let needsRefresh = false;
		const resumed = await maybeResumeCompactAndSeed(
			session,
			currentMessages,
			() => mintTelegramThreadId(chatId),
		);
		if (!resumed) {
			const compacted = await maybeAutoCompactAndSeed(
				session,
				currentMessages,
				queuedTurn.content,
				() => mintTelegramThreadId(chatId),
			);
			needsRefresh = compacted;
		} else {
			needsRefresh = true;
		}
		const taskCheck = await maybeRunPendingTaskCheck(
			session,
			queuedTurn.currentUserText ?? queuedTurn.content,
		);
		if (taskCheck.handled) {
			await sendTelegramMessage(bot, chatId, taskCheck.reply ?? "");
			return;
		}
		if (needsRefresh || taskCheck.needsRefresh) {
			await session.refreshAgent();
		}
		const invokeMessages = buildInvokeMessages(session, {
			role: "user",
			content: queuedTurn.content,
		});
		const stream = await session.agent.stream(
			{ messages: invokeMessages },
			{
				configurable: { thread_id: session.threadId },
				streamMode: "messages",
			},
		);
		let pendingReply = "";
		let streamedReply = "";
		let sentAnyReply = false;
		const streamIterator = stream[Symbol.asyncIterator]();
		const flushTick = Symbol("telegram-stream-flush-tick");
		let nextChunk = streamIterator.next();

		while (true) {
			const raced = await Promise.race([
				nextChunk,
				new Promise<typeof flushTick>((resolve) => {
					setTimeout(
						() => resolve(flushTick),
						TELEGRAM_STREAM_PARAGRAPH_FLUSH_INTERVAL_MS,
					);
				}),
			]);
			if (raced === flushTick) {
				const flushable = takeTelegramParagraphStreamChunks(pendingReply);
				pendingReply = flushable.remainder;
				for (const part of flushable.chunks) {
					await sendTelegramMessage(bot, chatId, part);
					sentAnyReply = true;
				}

				const overflowFlush = takeTelegramOverflowStreamChunks(pendingReply);
				pendingReply = overflowFlush.remainder;
				for (const part of overflowFlush.chunks) {
					await sendTelegramMessage(bot, chatId, part);
					sentAnyReply = true;
				}
				continue;
			}

			if (raced.done) break;
			nextChunk = streamIterator.next();
			const chunk = raced.value;
			if (!Array.isArray(chunk) || chunk.length < 1) continue;
			const message = chunk[0];
			const text = extractTelegramStreamText(message);
			if (text === "") continue;

			const merged = mergeTelegramStreamText(streamedReply, text);
			streamedReply = merged.fullText;
			if (merged.delta === "") continue;

			pendingReply += merged.delta;
			const flushable = takeTelegramParagraphStreamChunks(pendingReply);
			pendingReply = flushable.remainder;
			for (const part of flushable.chunks) {
				await sendTelegramMessage(bot, chatId, part);
				sentAnyReply = true;
			}

			const overflowFlush = takeTelegramOverflowStreamChunks(pendingReply);
			pendingReply = overflowFlush.remainder;
			for (const part of overflowFlush.chunks) {
				await sendTelegramMessage(bot, chatId, part);
				sentAnyReply = true;
			}
		}

		const finalFlush = takeTelegramStreamChunks(pendingReply, true);
		for (const part of finalFlush.chunks) {
			await sendTelegramMessage(bot, chatId, part);
			sentAnyReply = true;
		}

		if (!sentAnyReply) {
			const finalReply = await getTelegramFinalAgentReply(session);
			if (finalReply !== "") {
				await sendTelegramMessage(bot, chatId, finalReply);
				sentAnyReply = true;
			}
		}

		if (!sentAnyReply) {
			await sendTelegramMessage(
				bot,
				chatId,
				"The agent completed the task but did not return a text response.",
			);
		}
		clearPendingCompactionSeed(session);
		clearPendingTaskCheckContext(session);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown Telegram bot error";
		await sendTelegramMessage(bot, chatId, `Request failed: ${message}`);
	} finally {
		session.currentUserText = undefined;
		stopTyping();
	}
}

async function pumpQueue(
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
): Promise<void> {
	if (session.running) return;
	const next = session.queue.shift();
	if (next === undefined) return;
	session.running = true;
	try {
		await runAgentTurn(session, bot, chatId, next);
	} finally {
		session.running = false;
		if (session.queue.length > 0) {
			void pumpQueue(session, bot, chatId);
		}
	}
}

export function maybeHandleTelegramApprovalReply(
	session: TelegramAgentSession,
	text: string,
): { handled: boolean; reply?: string } {
	const pendingCount = session.pendingApprovals.size;
	const pending = session.pendingApprovals.values().next().value;
	if (!pending) return { handled: false };
	const normalized = text.trim().toLowerCase();
	if (["yes", "y", "approve"].includes(normalized)) {
		if (pendingCount > 1) {
			return {
				handled: true,
				reply:
					"Several approvals are pending. Use the buttons on the specific prompt instead of plain text.",
			};
		}
		session.pendingApprovals.delete(pending.promptId);
		void pending.resolve("approve-once");
		return { handled: true };
	}
	if (["always", "a"].includes(normalized)) {
		if (pendingCount > 1) {
			return {
				handled: true,
				reply:
					"Several approvals are pending. Use the buttons on the specific prompt instead of plain text.",
			};
		}
		session.pendingApprovals.delete(pending.promptId);
		void pending.resolve("approve-always");
		return { handled: true };
	}
	if (["no", "n", "deny"].includes(normalized)) {
		if (pendingCount > 1) {
			return {
				handled: true,
				reply:
					"Several approvals are pending. Use the buttons on the specific prompt instead of plain text.",
			};
		}
		session.pendingApprovals.delete(pending.promptId);
		void pending.resolve("deny-once");
		return { handled: true };
	}
	if (["never", "d"].includes(normalized)) {
		if (pendingCount > 1) {
			return {
				handled: true,
				reply:
					"Several approvals are pending. Use the buttons on the specific prompt instead of plain text.",
			};
		}
		session.pendingApprovals.delete(pending.promptId);
		void pending.resolve("deny-always");
		return { handled: true };
	}
	return { handled: false };
}

async function handleTelegramControlInput(
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
	commandText: string,
	caller: Caller,
	store: PermissionsStore,
	webShare: ChannelRunOptions["webShare"],
): Promise<boolean> {
	if (commandText !== "") {
		const approvalReply = maybeHandleTelegramApprovalReply(
			session,
			commandText,
		);
		if (approvalReply.handled) {
			if (approvalReply.reply) {
				await sendTelegramMessage(bot, chatId, approvalReply.reply);
			}
			return true;
		}

		if (
			extractTelegramCommandName(commandText) !== null &&
			(session.running || session.queue.length > 0)
		) {
			await sendTelegramMessage(
				bot,
				chatId,
				"Wait for the current queued turn to finish before sending another Telegram command.",
			);
			return true;
		}

		const sessionCommand = await maybeHandleSessionCommand(commandText, {
			session,
			model: session.model,
			backend: session.workspace,
			mintThreadId: () => mintTelegramThreadId(chatId),
			compaction: session.compactionConfig
				? {
						caller: session.compactionConfig.caller,
						store: session.compactionConfig.store,
					}
				: undefined,
			webShare: webShare
				? {
						access: webShare.access,
						publicBaseUrl: webShare.publicBaseUrl,
						callerId: caller.id,
					}
				: undefined,
		});
		if (sessionCommand.handled) {
			await sendTelegramMessage(bot, chatId, sessionCommand.reply);
			return true;
		}

		const command = await maybeHandleCommand(commandText, caller, store);
		if (command.handled) {
			await sendTelegramMessage(bot, chatId, command.reply);
			return true;
		}

		const slashCommand = extractTelegramCommandName(commandText);
		if (slashCommand !== null) {
			await sendTelegramMessage(
				bot,
				chatId,
				formatUnknownTelegramCommandReply(slashCommand),
			);
			return true;
		}
	}

	return false;
}

export async function handleTelegramVoiceMessage(
	params: {
		session: TelegramAgentSession;
		bot: Bot;
		chatId: string;
		caller: Caller;
		store: PermissionsStore;
		webShare: ChannelRunOptions["webShare"];
		botToken: string;
		voice: TelegramVoiceFile;
		caption?: string | null;
		getFile: () => Promise<{ file_path?: string }>;
	},
	deps?: {
		fetchVoice?: typeof fetchVoiceBytes;
		queueTurn?: typeof handleTelegramQueuedTurn;
		sendMessage?: typeof sendTelegramMessage;
	},
): Promise<void> {
	const sendMessage = deps?.sendMessage ?? sendTelegramMessage;
	const fetchVoice = deps?.fetchVoice ?? fetchVoiceBytes;
	const queueTurn = deps?.queueTurn ?? handleTelegramQueuedTurn;

	if (params.session.transcriber instanceof NoOpTranscriber) {
		await sendMessage(
			params.bot,
			params.chatId,
			"Voice messages are not supported on this server.",
		);
		return;
	}

	if (
		typeof params.voice.file_size === "number" &&
		params.voice.file_size > VOICE_MAX_BYTES
	) {
		await sendMessage(params.bot, params.chatId, "Voice message is too large");
		return;
	}

	let downloaded: { data: Uint8Array; filePath: string };
	try {
		const file = await params.getFile();
		downloaded = await fetchVoice(file, params.botToken);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown voice download error";
		await sendMessage(
			params.bot,
			params.chatId,
			`Failed to download voice message: ${message}`,
		);
		return;
	}

	try {
		const transcript = await params.session.transcriber.transcribe(
			downloaded.data,
			VOICE_MIME_TYPE,
		);
		const commandText = normalizeTelegramCommandText(transcript);
		const content = buildVoiceContent(transcript, params.caption);
		const currentUserText = buildVoiceTurnText(transcript, params.caption);
		await queueTurn(
			params.session,
			params.bot,
			params.chatId,
			commandText,
			content,
			params.caller,
			params.store,
			params.webShare,
			currentUserText,
		);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Unknown voice transcription error";
		await sendMessage(
			params.bot,
			params.chatId,
			`Transcription failed: ${message}`,
		);
	}
}

export async function handleTelegramPdfMessage(
	params: {
		session: TelegramAgentSession;
		bot: Bot;
		chatId: string;
		caller: Caller;
		store: PermissionsStore;
		webShare: ChannelRunOptions["webShare"];
		botToken: string;
		document: TelegramDocumentFile;
		filename: string;
		getFile: () => Promise<{ file_path?: string }>;
	},
	deps?: {
		fetchPdf?: typeof fetchTelegramFileBytes;
		queueTurn?: typeof handleTelegramQueuedTurn;
		sendMessage?: typeof sendTelegramMessage;
	},
): Promise<void> {
	const sendMessage = deps?.sendMessage ?? sendTelegramMessage;
	const fetchPdf = deps?.fetchPdf ?? fetchTelegramFileBytes;
	const queueTurn = deps?.queueTurn ?? handleTelegramQueuedTurn;

	if (
		typeof params.document.file_size === "number" &&
		params.document.file_size > PDF_MAX_BYTES
	) {
		await sendMessage(params.bot, params.chatId, "PDF is too large (max 20 MB).");
		return;
	}

	if (params.session.pdfExtractor instanceof NoOpPdfExtractor) {
		await sendMessage(
			params.bot,
			params.chatId,
			"PDF documents are not supported on this server.",
		);
		return;
	}

	let downloaded: { data: Uint8Array; filePath: string };
	try {
		const file = await params.getFile();
		downloaded = await fetchPdf(file, params.botToken);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown PDF download error";
		await sendMessage(
			params.bot,
			params.chatId,
			`Failed to download PDF: ${message}`,
		);
		return;
	}

	try {
		const result = await params.session.pdfExtractor.extract(
			downloaded.data,
			params.filename,
		);

		if (result.isEncrypted) {
			await sendMessage(
				params.bot,
				params.chatId,
				"This PDF is password-protected and cannot be read.",
			);
			return;
		}

		if (result.isCorrupt !== "") {
			await sendMessage(
				params.bot,
				params.chatId,
				`Failed to read PDF: ${result.isCorrupt}`,
			);
			return;
		}

		const allPagesEmpty = result.pages.every((page) => page.text.trim() === "");
		if (allPagesEmpty) {
			await sendMessage(
				params.bot,
				params.chatId,
				"This PDF appears to contain no text.",
			);
			return;
		}

		const content = buildPdfContent(result.pages, params.filename);
		const currentUserText = buildPdfText(result.pages);
		await queueTurn(
			params.session,
			params.bot,
			params.chatId,
			"",
			content,
			params.caller,
			params.store,
			params.webShare,
			currentUserText,
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown PDF extraction error";
		await sendMessage(params.bot, params.chatId, `Failed to read PDF: ${message}`);
	}
}

async function handleTelegramQueuedTurn(
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
	commandText: string,
	content: TelegramUserInput,
	caller: Caller,
	store: PermissionsStore,
	webShare: ChannelRunOptions["webShare"],
	currentUserText?: string,
): Promise<void> {
	if (
		await handleTelegramControlInput(
			session,
			bot,
			chatId,
			commandText,
			caller,
			store,
			webShare,
		)
	) {
		return;
	}

	session.queue.push({ content, commandText, currentUserText });
	void pumpQueue(session, bot, chatId);
}

export const telegramChannel: AppChannel = {
	entrypoint: "telegram",
	async run(config: AppConfig, options?: ChannelRunOptions): Promise<void> {
		const webShare = options?.webShare;
		const transcriber =
			options?.transcriber ?? createTelegramTranscriber(config);
		const pdfExtractor =
			options?.pdfExtractor ??
			(config.enablePdfDocuments === false
				? new NoOpPdfExtractor()
				: new PdfExtractExtractor());
		const db = options?.db ?? createDb(config.databaseUrl);
		const dialect = options?.dialect ?? detectDialect(config.databaseUrl);
		const store = new PermissionsStore({ db, dialect });
		const sessions = new Map<string, TelegramAgentSession>();
		const bot = new Bot(config.telegramBotToken);
		const outbound = new TelegramOutboundChannel(bot, (callerId) => {
			const telegramPrefix = "telegram:";
			if (!callerId.startsWith(telegramPrefix)) return null;
			const chatId = callerId.slice(telegramPrefix.length);
			if (!sessions.has(chatId)) return null;
			return chatId;
		});
		await syncTelegramCommands(bot);

		console.log("Starting Telegram bot polling loop with grammy.");
		if (config.telegramAllowedChatId !== "") {
			console.warn(
				"TELEGRAM_BOT_ALLOWED_CHAT_ID is deprecated; access is now governed by harness_users. Ignoring.",
			);
		}

		bot.on("callback_query:data", async (ctx) => {
			const chatId = ctx.chat?.id;
			const data = ctx.callbackQuery.data;
			if (chatId === undefined || data === "") {
				await ctx.answerCallbackQuery().catch(() => undefined);
				return;
			}

			const chatIdString = String(chatId);
			const session = sessions.get(chatIdString);
			const separator = data.indexOf(":");
			const outcome = separator === -1 ? data : data.slice(0, separator);
			const promptId = separator === -1 ? "" : data.slice(separator + 1);
			const pending = session?.pendingApprovals.get(promptId);
			if (
				pending &&
				(outcome === "approve-once" ||
					outcome === "approve-always" ||
					outcome === "deny-once" ||
					outcome === "deny-always")
			) {
				session?.pendingApprovals.delete(promptId);
				await pending.resolve(outcome);
			}

			await ctx.answerCallbackQuery().catch(() => undefined);
		});

		bot.on("message:text", async (ctx) => {
			const chatId = ctx.chat.id;
			const text = normalizeTelegramCommandText(ctx.message.text);
			if (text === "") return;

			const chatIdString = String(chatId);
			const caller = await getTelegramCaller(store, chatIdString);
			if (!caller) {
				await sendTelegramMessage(bot, chatIdString, config.blockedUserMessage);
				return;
			}

			const session = await ensureTelegramSession(
				chatIdString,
				caller,
				config,
				db,
				dialect,
				store,
				bot,
				sessions,
				outbound,
				webShare,
				transcriber,
				pdfExtractor,
			);

			await handleTelegramQueuedTurn(
				session,
				bot,
				chatIdString,
				text,
				text,
				caller,
				store,
				webShare,
			);
		});

		bot.on("message:photo", async (ctx) => {
			const chatIdString = String(ctx.chat.id);
			const caller = await getTelegramCaller(store, chatIdString);
			if (!caller) {
				await sendTelegramMessage(bot, chatIdString, config.blockedUserMessage);
				return;
			}

			const session = await ensureTelegramSession(
				chatIdString,
				caller,
				config,
				db,
				dialect,
				store,
				bot,
				sessions,
				outbound,
				webShare,
				transcriber,
				pdfExtractor,
			);
			const caption = normalizeTelegramCommandText(ctx.message.caption);

			try {
				if (
					await handleTelegramControlInput(
						session,
						bot,
						chatIdString,
						caption,
						caller,
						store,
						webShare,
					)
				) {
					return;
				}

				const file = await ctx.getFile();
				const downloaded = await fetchTelegramFileBytes(
					file,
					config.telegramBotToken,
				);
				const content = buildTelegramPhotoContent(downloaded.data, {
					caption,
					filePath: downloaded.filePath,
				});

				await handleTelegramQueuedTurn(
					session,
					bot,
					chatIdString,
					"",
					content,
					caller,
					store,
					webShare,
				);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Unknown Telegram photo handling error";
				await sendTelegramMessage(
					bot,
					chatIdString,
					`Request failed: ${message}`,
				);
			}
		});

		bot.on("message:voice", async (ctx) => {
			const chatIdString = String(ctx.chat.id);
			const caller = await getTelegramCaller(store, chatIdString);
			if (!caller) {
				await sendTelegramMessage(bot, chatIdString, config.blockedUserMessage);
				return;
			}

			const session = await ensureTelegramSession(
				chatIdString,
				caller,
				config,
				db,
				dialect,
				store,
				bot,
				sessions,
				outbound,
				webShare,
				transcriber,
				pdfExtractor,
			);

			await handleTelegramVoiceMessage({
				session,
				bot,
				chatId: chatIdString,
				caller,
				store,
				webShare,
				botToken: config.telegramBotToken,
				voice: ctx.message.voice,
				caption: normalizeTelegramCommandText(ctx.message.caption),
				getFile: () => ctx.getFile(),
			});
		});

		bot.on("message:document", async (ctx) => {
			if (ctx.message.document.mime_type !== "application/pdf") {
				return;
			}

			const chatIdString = String(ctx.chat.id);
			const caller = await getTelegramCaller(store, chatIdString);
			if (!caller) {
				await sendTelegramMessage(bot, chatIdString, config.blockedUserMessage);
				return;
			}

			const session = await ensureTelegramSession(
				chatIdString,
				caller,
				config,
				db,
				dialect,
				store,
				bot,
				sessions,
				outbound,
				webShare,
				transcriber,
				pdfExtractor,
			);

			await handleTelegramPdfMessage({
				session,
				bot,
				chatId: chatIdString,
				caller,
				store,
				webShare,
				botToken: config.telegramBotToken,
				document: ctx.message.document,
				filename: ctx.message.document.file_name ?? "document.pdf",
				getFile: () => ctx.getFile(),
			});
		});

		bot.catch(async (error) => {
			console.error("Telegram bot error:", error.error);
		});

		await bot.start({
			onStart: (botInfo) => {
				console.log(`Telegram bot connected as @${botInfo.username}`);
			},
		});
		if (!options?.db) {
			await db.close();
		}
	},
};
