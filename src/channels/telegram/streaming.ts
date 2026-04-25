import {
	TELEGRAM_MAX_MESSAGE_LENGTH,
	TELEGRAM_STREAM_CHUNK_MIN_LENGTH,
	TELEGRAM_STREAM_CHUNK_TARGET_LENGTH,
	TELEGRAM_STREAM_CHUNK_HARD_LENGTH,
	TELEGRAM_STREAM_DEFAULT_BOUNDARY_PATTERNS,
	TELEGRAM_STREAM_PARAGRAPH_BOUNDARY_PATTERNS,
	TELEGRAM_STREAM_OVERFLOW_BOUNDARY_PATTERNS,
} from "./types";
import {
	isSafeTelegramMarkdownChunk,
	scanTelegramMarkdownChunkContext,
	hasOpenTelegramMarkdownStructures,
} from "./markdown";
import { renderTelegramHtml } from "./markdown";

// --- Stream boundary finding ---

export function findTelegramStreamBoundary(
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

// --- Static chunking ---

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

export function chunkTelegramMessage(text: string): string[] {
	return chunkTelegramText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
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

// Need to import splitOversizedMarkdownTableSource from markdown
import { splitOversizedMarkdownTableSource } from "./markdown";

// --- Text overlap / merge ---

export function findTelegramTextOverlap(previous: string, next: string): number {
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
