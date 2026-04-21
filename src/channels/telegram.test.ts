import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Bot } from "grammy";
import { OpenRouterTranscriber } from "../capabilities/voice/openrouter_transcriber";
import {
	NoOpTranscriber,
	type Transcriber,
} from "../capabilities/voice/transcriber";
import { WhisperTranscriber } from "../capabilities/voice/whisper_transcriber";
import {
	NoOpPdfExtractor,
	type PdfExtractor,
	type PdfExtractionResult,
} from "../capabilities/pdf/extractor";
import {
	NoOpSpreadsheetParser,
	type SpreadsheetParser,
	type SpreadsheetParseResult,
} from "../capabilities/spreadsheet/parser";
import type { AppConfig } from "../config";
import type { ApprovalOutcome } from "../permissions/approval";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import { TimerStore } from "../capabilities/timers/store";
import { startScheduler, type SchedulerOptions } from "../capabilities/timers/scheduler";
import type { TimerRecord } from "../capabilities/timers/store";
import {
	buildTelegramPhotoContent,
	chunkRenderedTelegramMessages,
	chunkTelegramMessage,
	createTelegramTranscriber,
	ensureTelegramSession,
	extractTelegramCommandName,
	extractTelegramReplyFromAgentState,
	fetchTelegramFileBytes,
	formatUnknownTelegramCommandReply,
	getTelegramCaller,
	handleTelegramPdfMessage,
	handleTelegramSpreadsheetMessage,
	handleTelegramVoiceMessage,
	maybeHandleTelegramApprovalReply,
	mergeTelegramStreamText,
	renderTelegramCaptionHtml,
	renderTelegramHtml,
	takeTelegramOverflowStreamChunks,
	takeTelegramParagraphStreamChunks,
	takeTelegramStreamChunks,
} from "./telegram";

let store: PermissionsStore;

const TEST_CONFIG: AppConfig = {
	aiApiKey: "test-key",
	aiBaseUrl: "",
	aiType: "openai",
	aiModelName: "gpt-4o-mini",
	appEntrypoint: "telegram",
	telegramBotToken: "telegram-token",
	telegramAllowedChatId: "",
	usingMode: "single",
	blockedUserMessage: "blocked",
	permissionsMode: "disabled",
	databaseUrl: "sqlite://:memory:",
	enableExecute: false,
	enablePdfDocuments: true,
	enableSpreadsheets: true,
	enableVoiceMessages: true,
	transcriptionProvider: "openai",
	transcriptionApiKey: "test-key",
	transcriptionBaseUrl: "",
	webPort: 8083,
	webPublicBaseUrl: "http://localhost:8083",
	timezone: "UTC",
};

afterEach(() => {
	store?.close();
});

const createTelegramSessionFixture = (
	transcriber: Transcriber,
): Awaited<ReturnType<typeof ensureTelegramSession>> => {
	const mockPdfExtractor: PdfExtractor = {
		async extract(_pdfBytes: Uint8Array, _filename: string) {
			throw new Error("PDF extraction not configured");
		},
	};
	const mockSpreadsheetParser: SpreadsheetParser = new NoOpSpreadsheetParser();
	return {
		agent: {} as never,
		running: false,
		queue: [],
		threadId: "telegram-123",
		workspace: {} as never,
		model: {} as never,
		refreshAgent: async () => {},
		transcriber,
		pdfExtractor: mockPdfExtractor,
		spreadsheetParser: mockSpreadsheetParser,
		pendingApprovals: new Map(),
	} as Awaited<ReturnType<typeof ensureTelegramSession>>;
};

describe("telegram channel", () => {
	test("createTelegramTranscriber returns no-op when voice messages are disabled", () => {
		const transcriber = createTelegramTranscriber({
			...TEST_CONFIG,
			enableVoiceMessages: false,
		});

		expect(transcriber).toBeInstanceOf(NoOpTranscriber);
	});

	test("createTelegramTranscriber returns whisper when voice messages are enabled", () => {
		const transcriber = createTelegramTranscriber(TEST_CONFIG);

		expect(transcriber).toBeInstanceOf(WhisperTranscriber);
	});

	test("createTelegramTranscriber uses the OpenRouter chat completions audio endpoint", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			expect(String(input)).toBe(
				"https://openrouter.ai/api/v1/chat/completions",
			);
			expect(init?.method).toBe("POST");
			expect(init?.headers).toMatchObject({
				Authorization: "Bearer voice-key",
				"Content-Type": "application/json",
			});
			expect(init?.body).toBeString();
			const payload = JSON.parse(String(init?.body)) as {
				model: string;
				messages: Array<{
					role: string;
					content: Array<
						| { type: "text"; text: string }
						| {
								type: "input_audio";
								input_audio: { data: string; format: string };
						  }
					>;
				}>;
			};
			expect(payload.model).toBe("openai/whisper-1");
			expect(payload.messages[0]?.role).toBe("user");
			expect(payload.messages[0]?.content[0]).toEqual({
				type: "text",
				text: "Transcribe this audio verbatim. Return only the transcript text.",
			});
			expect(payload.messages[0]?.content[1]).toEqual({
				type: "input_audio",
				input_audio: {
					data: Buffer.from([1, 2, 3]).toString("base64"),
					format: "ogg",
				},
			});
			return Response.json({
				choices: [{ message: { content: "transcribed" } }],
			});
		}) as typeof fetch;

		try {
			const transcriber = createTelegramTranscriber({
				...TEST_CONFIG,
				aiType: "anthropic",
				aiApiKey: "anthropic-key",
				aiBaseUrl: "https://anthropic.example",
				transcriptionProvider: "openrouter",
				transcriptionApiKey: "voice-key",
			});

			expect(transcriber).toBeInstanceOf(OpenRouterTranscriber);
			await expect(
				transcriber.transcribe(Uint8Array.from([1, 2, 3]), "audio/ogg"),
			).resolves.toBe("transcribed");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("ensureTelegramSession attaches the configured transcriber", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		try {
			const permissionStore = new PermissionsStore({ db, dialect: "sqlite" });
			const sessions = new Map<
				string,
				Awaited<ReturnType<typeof ensureTelegramSession>>
			>();
			const transcriber: Transcriber = new NoOpTranscriber();
			const caller: Caller = {
				id: "telegram:123",
				entrypoint: "telegram",
				externalId: "123",
				displayName: "Chat 123",
			};

			const session = await ensureTelegramSession(
				"123",
				caller,
				TEST_CONFIG,
				db,
				"sqlite",
				permissionStore,
				{} as Bot,
				sessions,
				{
					sendFile: async () => ({ ok: true }),
				},
				undefined,
				transcriber,
				new NoOpPdfExtractor(),
				new NoOpSpreadsheetParser(),
			);

			expect(session.transcriber).toBe(transcriber);
			expect(sessions.get("123")).toBe(session);
		} finally {
			await db.close();
		}
	});

	test("chunkTelegramMessage splits oversized payloads", () => {
		const longText = "a".repeat(5000);
		const chunks = chunkTelegramMessage(longText);

		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.length).toBe(4096);
		expect(chunks.join("")).toBe(longText);
	});

	test("chunkTelegramMessage prefers natural breakpoints", () => {
		const firstParagraph = "a".repeat(3000);
		const secondParagraph = "b".repeat(1500);
		const text = `${firstParagraph}\n\n${secondParagraph}`;
		const chunks = chunkTelegramMessage(text);

		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toBe(`${firstParagraph}\n\n`);
		expect(chunks.join("")).toBe(text);
	});

	test("chunkRenderedTelegramMessages keeps rendered payloads under Telegram limit", () => {
		const text = Array.from({ length: 1200 }, () => "**Opus** value")
			.join("\n")
			.concat("\n");
		const chunks = chunkRenderedTelegramMessages(text);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
		expect(chunks[0]).toContain("<b>Opus</b>");
	});

	test("chunkRenderedTelegramMessages splits oversized tables by rows", () => {
		const rows = Array.from(
			{ length: 220 },
			(_, index) =>
				`| Row ${index + 1} | ${"Value ".repeat(12).trim()} ${index + 1} |`,
		).join("\n");
		const text = `| Name | Value |
| --- | --- |
${rows}`;
		const chunks = chunkRenderedTelegramMessages(text);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
		expect(chunks[0]).toContain("<b>Row 1</b>:");
		expect(chunks.at(-1)).toContain("<b>Row 220</b>:");
	});

	test("chunkRenderedTelegramMessages preserves headers when splitting a wide comparison row", () => {
		const longCell =
			"Reasoning, coding, analysis, safety, documents, tools, vision, speed, ecosystem. "
				.repeat(30)
				.trim();
		const text = `| Dimension | **Claude Opus** | **ChatGPT 4o** | **DeepSeek V3** | **Kimi K1.5** |
| --- | --- | --- | --- | --- |
| Strengths | ${longCell} | ${longCell} | ${longCell} | ${longCell} |`;
		const chunks = chunkRenderedTelegramMessages(text);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
		expect(chunks.every((chunk) => !chunk.includes("|"))).toBe(true);
		expect(chunks.every((chunk) => chunk.includes("<b>Strengths</b>"))).toBe(
			true,
		);
		expect(
			chunks.every((chunk) =>
				/Claude Opus|ChatGPT 4o|DeepSeek V3|Kimi K1\.5/.test(chunk),
			),
		).toBe(true);
		expect(chunks.some((chunk) => chunk.includes("ChatGPT 4o"))).toBe(true);
		expect(chunks.some((chunk) => chunk.includes("DeepSeek V3"))).toBe(true);
		expect(chunks.some((chunk) => chunk.includes("Kimi K1.5"))).toBe(true);
	});

	test("chunkRenderedTelegramMessages keeps later comparison chunks rendered", () => {
		const longCell =
			"Reasoning, coding, analysis, safety, documents, tools, vision, speed, ecosystem. "
				.repeat(12)
				.trim();
		const text = `Here's a comparison of 4 AI models:

| Dimension | Claude Opus | ChatGPT 4o | DeepSeek V3 | Kimi K1.5 |
| --- | --- | --- | --- | --- |
| Developer | Anthropic (US) | OpenAI (US) | DeepSeek (China) | Moonshot AI (China) |
| Context Window | ${longCell} | ${longCell} | ${longCell} | ${longCell} |
| Strengths | ${longCell} | ${longCell} | ${longCell} | ${longCell} |
| Weaknesses | ${longCell} | ${longCell} | ${longCell} | ${longCell} |
| Pricing | ${longCell} | ${longCell} | ${longCell} | ${longCell} |`;
		const chunks = chunkRenderedTelegramMessages(text);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
		expect(chunks.every((chunk) => !chunk.includes("| Pricing |"))).toBe(true);
		const pricingChunk = chunks.find((chunk) =>
			chunk.includes("<b>Pricing</b>"),
		);
		expect(pricingChunk).toBeDefined();
		expect(
			/Claude Opus|ChatGPT 4o|DeepSeek V3|Kimi K1\.5/.test(pricingChunk ?? ""),
		).toBe(true);
	});

	test("takeTelegramStreamChunks flushes at paragraph boundaries", () => {
		const result = takeTelegramStreamChunks(
			`${"A".repeat(260)}.\n\n${"B".repeat(260)}.\n\nTail`,
		);

		expect(result.chunks).toHaveLength(1);
		expect(result.chunks[0]).toContain(`${"A".repeat(260)}.`);
		expect(result.chunks[0]).toContain(`${"B".repeat(260)}.`);
		expect(result.remainder).toBe("Tail");
	});

	test("takeTelegramStreamChunks waits for fenced code blocks to close", () => {
		const partial = takeTelegramStreamChunks(
			`Intro paragraph that is definitely long enough to flush once it is safe.\n\n\`\`\`ts\nconst value = 1;`,
		);
		expect(partial.chunks).toHaveLength(0);

		const complete = takeTelegramStreamChunks(
			`Intro paragraph that is definitely long enough to flush once it is safe.\n\n\`\`\`ts\nconst value = 1;\n\`\`\`\n\nDone.`,
			true,
		);
		expect(complete.chunks.join("\n\n")).toContain("```ts");
		expect(complete.remainder).toBe("");
	});

	test("takeTelegramStreamChunks waits for inline markdown structures to close", () => {
		const partial = takeTelegramStreamChunks(
			`${"Intro text ".repeat(30)} **bold and \`code`,
		);
		expect(partial.chunks).toHaveLength(0);

		const complete = takeTelegramStreamChunks(
			`${"Intro text ".repeat(30)} **bold and \`code\`** done.`,
			true,
		);
		expect(complete.chunks).toHaveLength(1);
		expect(complete.chunks[0]).toContain("**bold and `code`**");
	});

	test("takeTelegramStreamChunks keeps an in-progress trailing table buffered", () => {
		const intro =
			"This paragraph is intentionally long so the stream chunker is willing to flush it before the table is complete. "
				.repeat(3)
				.trim();
		const partial = takeTelegramStreamChunks(
			`${intro}\n\n| Name | Value |\n| --- | --- |\n| Opus | Model |`,
		);

		expect(partial.chunks).toEqual([intro]);
		expect(partial.remainder).toBe(
			"| Name | Value |\n| --- | --- |\n| Opus | Model |",
		);

		const complete = takeTelegramStreamChunks(
			`${partial.remainder}\n| GPT-4o | Fast responses |\n\nDone.`,
			true,
		);
		expect(complete.chunks.join("\n\n")).toContain(
			"| GPT-4o | Fast responses |",
		);
		expect(complete.chunks.join("\n\n")).toContain("Done.");
		expect(complete.remainder).toBe("");
	});

	test("takeTelegramStreamChunks keeps trailing table headers with buffered rows", () => {
		const intro =
			"This intro is long enough that the stream chunker should flush it before buffering the table block. "
				.repeat(4)
				.trim();
		const partial = takeTelegramStreamChunks(
			`${intro}\n\n| Dimension | Claude Opus | ChatGPT 4o |\n| --- | --- | --- |\n| Strengths | Long context | Fast responses |`,
		);

		expect(partial.chunks).toEqual([intro]);
		expect(partial.remainder).toContain(
			"| Dimension | Claude Opus | ChatGPT 4o |",
		);
		expect(partial.remainder).toContain("| --- | --- | --- |");
		expect(partial.remainder).toContain(
			"| Strengths | Long context | Fast responses |",
		);
	});

	test("takeTelegramStreamChunks final flush preserves complete tables", () => {
		const text = `Here's a comparison:

| Dimension | Claude Opus | ChatGPT 4o | DeepSeek | Kimi |
| --- | --- | --- | --- | --- |
| Developer | Anthropic | OpenAI | DeepSeek | Moonshot |
| Strengths | Reasoning, coding, safety | Multimodal, speed, ecosystem | Coding, low cost | Long context, Chinese NLP |
| Best For | Complex analysis | General use | Budget coding | Long documents |

Quick verdict`;

		const result = takeTelegramStreamChunks(text, true);

		expect(result.chunks).toEqual([text]);
		expect(result.remainder).toBe("");
	});

	test("takeTelegramParagraphStreamChunks flushes short completed paragraphs", () => {
		const result = takeTelegramParagraphStreamChunks(
			"Short intro.\n\nStill buffering",
		);

		expect(result.chunks).toEqual(["Short intro."]);
		expect(result.remainder).toBe("Still buffering");
	});

	test("takeTelegramParagraphStreamChunks does not flush on a single wrapped newline", () => {
		const result = takeTelegramParagraphStreamChunks(
			"Knowledge Gap Mapping: When working on a complex topic where you repeatedly reference different domains, I should identify what you have not\ntouched yet but will need later.",
		);

		expect(result.chunks).toEqual([]);
		expect(result.remainder).toContain("have not\ntouched yet");
	});

	test("takeTelegramParagraphStreamChunks does not flush on an unfinished paragraph before a blank line", () => {
		const result = takeTelegramParagraphStreamChunks(
			"Knowledge Gap Mapping: When working on a complex topic where you repeatedly reference different domains, I should identify what you have not\n\ntouched yet but will need later.",
		);

		expect(result.chunks).toEqual([]);
		expect(result.remainder).toContain("have not\n\ntouched yet");
	});

	test("takeTelegramOverflowStreamChunks flushes oversized unfinished text on safe boundaries", () => {
		const text = Array.from(
			{ length: 500 },
			() => "**functional outcomes** over showing technical steps",
		).join(" ");

		const result = takeTelegramOverflowStreamChunks(text);

		expect(result.chunks.length).toBeGreaterThan(0);
		expect(
			renderTelegramHtml(result.chunks[0] ?? "").length,
		).toBeLessThanOrEqual(4096);
		expect(renderTelegramHtml(result.chunks[0] ?? "")).toContain(
			"<b>functional outcomes</b>",
		);
		expect(result.remainder.length).toBeGreaterThan(0);
	});

	test("mergeTelegramStreamText handles cumulative snapshots and overlaps", () => {
		const first = mergeTelegramStreamText("", "Hello");
		expect(first).toEqual({ fullText: "Hello", delta: "Hello" });

		const second = mergeTelegramStreamText(first.fullText, "Hello world");
		expect(second).toEqual({ fullText: "Hello world", delta: " world" });

		const third = mergeTelegramStreamText(second.fullText, " world!");
		expect(third).toEqual({ fullText: "Hello world!", delta: "!" });
	});

	test("renderTelegramHtml converts common markdown to Telegram-safe HTML", () => {
		const rendered = renderTelegramHtml(
			'**Opus** uses `markdown` safely.\n\n```ts\nconsole.log("<test>");\n```',
		);

		expect(rendered).toContain("<b>Opus</b>");
		expect(rendered).toContain("<code>markdown</code>");
		expect(rendered).toContain(
			'<pre><code class="language-ts">console.log("&lt;test&gt;");\n</code></pre>',
		);
	});

	test("renderTelegramHtml renders headings, emphasis, links, lists, and blockquotes", () => {
		const rendered = renderTelegramHtml(`# Title

Paragraph with *italic*, **bold**, and [docs](https://example.com/a?b=1).

1. First
2. Second

- Item A
- Item B

> Quoted line`);

		expect(rendered).toContain("<b>Title</b>");
		expect(rendered).toContain("<i>italic</i>");
		expect(rendered).toContain("<b>bold</b>");
		expect(rendered).toContain('<a href="https://example.com/a?b=1">docs</a>');
		expect(rendered).toContain("1. First");
		expect(rendered).toContain("2. Second");
		expect(rendered).toContain("• Item A");
		expect(rendered).toContain("• Item B");
		expect(rendered).toContain("<blockquote>Quoted line</blockquote>");
	});

	test("renderTelegramHtml converts markdown tables into Telegram-friendly sections", () => {
		const rendered = renderTelegramHtml(`| Name | Value |
| --- | --- |
| Opus | Model |
| Opus | Codec |`);

		expect(rendered).not.toContain("<table>");
		expect(rendered).toContain("<b>Opus</b>: Model");
		expect(rendered).toContain("<b>Opus</b>: Codec");
	});

	test("renderTelegramHtml formats comparison tables with row headings and bullets", () => {
		const rendered = renderTelegramHtml(`| Dimension | Claude Opus | GPT-4o |
| --- | --- | --- |
| Strengths | Long context | Fast responses |
| Speed | Deliberate | Real-time |`);

		expect(rendered).toContain("<b>Strengths</b>");
		expect(rendered).toContain("• <b>Claude Opus</b>: Long context");
		expect(rendered).toContain("• <b>GPT-4o</b>: Fast responses");
		expect(rendered).toContain("<b>Speed</b>");
	});

	test("renderTelegramHtml preserves markdown and line breaks inside table headers and cells", () => {
		const rendered =
			renderTelegramHtml(`| Dimension | **Claude Opus** (Anthropic) | **ChatGPT 4o** (OpenAI) |
| --- | --- | --- |
| Strengths | • Strong reasoning<br>• Long-document comprehension | • Fast inference<br>• Large ecosystem |`);

		expect(rendered).not.toContain("**Claude Opus**");
		expect(rendered).not.toContain("&lt;br&gt;");
		expect(rendered).not.toContain("<br>");
		expect(rendered).toContain("• <b>Claude Opus</b> (Anthropic):");
		expect(rendered).toContain("  • Long-document comprehension");
		expect(rendered).toContain("• <b>ChatGPT 4o</b> (OpenAI):");
	});

	test("renderTelegramCaptionHtml converts markdown and escapes raw HTML", () => {
		expect(renderTelegramCaptionHtml("**Report** <draft> & `code`")).toBe(
			"<b>Report</b> &lt;draft&gt; &amp; <code>code</code>",
		);
	});

	test("buildTelegramPhotoContent keeps caption text and image bytes", () => {
		const imageData = Uint8Array.from([1, 2, 3]);
		const content = buildTelegramPhotoContent(imageData, {
			caption: "what is in this photo?",
			filePath: "photos/cat.png",
		});

		expect(content).toEqual([
			{
				type: "text",
				text: "what is in this photo?",
			},
			{
				type: "image",
				mimeType: "image/png",
				data: imageData,
			},
		]);
	});

	test("buildTelegramPhotoContent adds fallback text for captionless photos", () => {
		const content = buildTelegramPhotoContent(Uint8Array.from([9]), {
			filePath: "photos/cat.jpg",
		});

		expect(content).toEqual([
			{
				type: "text",
				text: "User attached an image without a caption.",
			},
			{
				type: "image",
				mimeType: "image/jpeg",
				data: Uint8Array.from([9]),
			},
		]);
	});

	describe("message:voice", () => {
		test("queues transcribed voice content with appended caption text", async () => {
			const queuedTurns: Array<{
				commandText: string;
				content: unknown;
				currentUserText?: string;
			}> = [];
			const sentMessages: string[] = [];
			const session = createTelegramSessionFixture({
				transcribe: async (audioBytes: Uint8Array, mimeType: string) => {
					expect(audioBytes).toEqual(Uint8Array.from([4, 5, 6]));
					expect(mimeType).toBe("audio/ogg");
					return "hello world";
				},
			});

			await handleTelegramVoiceMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					voice: { file_size: 512 },
					caption: "follow up question",
					getFile: async () => ({ file_path: "voice/file_1.ogg" }),
				},
				{
					fetchVoice: async (file, botToken) => {
						expect(file).toEqual({ file_path: "voice/file_1.ogg" });
						expect(botToken).toBe("telegram-token");
						return {
							data: Uint8Array.from([4, 5, 6]),
							filePath: "voice/file_1.ogg",
						};
					},
					queueTurn: async (
						_session,
						_bot,
						_chatId,
						commandText,
						content,
						_caller,
						_store,
						_webShare,
						currentUserText,
					) => {
						queuedTurns.push({ commandText, content, currentUserText });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(queuedTurns).toEqual([
				{
					commandText: "hello world",
					content: "_Transcribed: hello world_\n\nfollow up question",
					currentUserText: "hello world\n\nfollow up question",
				},
			]);
			expect(sentMessages).toEqual([]);
		});

		test("rejects oversized audio before download", async () => {
			const sentMessages: string[] = [];
			let fetched = false;
			let transcribed = false;

			await handleTelegramVoiceMessage(
				{
					session: createTelegramSessionFixture({
						transcribe: async () => {
							transcribed = true;
							return "ignored";
						},
					}),
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					voice: { file_size: 1_048_577 },
					getFile: async () => ({ file_path: "voice/file_1.ogg" }),
				},
				{
					fetchVoice: async () => {
						fetched = true;
						return {
							data: Uint8Array.from([1]),
							filePath: "voice/file_1.ogg",
						};
					},
					queueTurn: async () => undefined,
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual(["Voice message is too large"]);
			expect(fetched).toBe(false);
			expect(transcribed).toBe(false);
		});

		test("surfaces transcription errors", async () => {
			const sentMessages: string[] = [];

			await handleTelegramVoiceMessage(
				{
					session: createTelegramSessionFixture({
						transcribe: async () => {
							throw new Error("backend unavailable");
						},
					}),
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					voice: { file_size: 42 },
					getFile: async () => ({ file_path: "voice/file_1.ogg" }),
				},
				{
					fetchVoice: async () => ({
						data: Uint8Array.from([1, 2, 3]),
						filePath: "voice/file_1.ogg",
					}),
					queueTurn: async () => undefined,
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual([
				"Transcription failed: backend unavailable",
			]);
		});

		test("surfaces download errors", async () => {
			const sentMessages: string[] = [];
			let transcribed = false;

			await handleTelegramVoiceMessage(
				{
					session: createTelegramSessionFixture({
						transcribe: async () => {
							transcribed = true;
							return "ignored";
						},
					}),
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					voice: { file_size: 42 },
					getFile: async () => ({ file_path: "voice/file_1.ogg" }),
				},
				{
					fetchVoice: async () => {
						throw new Error("status 404");
					},
					queueTurn: async () => undefined,
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual([
				"Failed to download voice message: status 404",
			]);
			expect(transcribed).toBe(false);
		});

		test("replies when no transcriber is configured", async () => {
			const sentMessages: string[] = [];
			let fetched = false;

			await handleTelegramVoiceMessage(
				{
					session: createTelegramSessionFixture(new NoOpTranscriber()),
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					voice: { file_size: 42 },
					getFile: async () => ({ file_path: "voice/file_1.ogg" }),
				},
				{
					fetchVoice: async () => {
						fetched = true;
						return {
							data: Uint8Array.from([1]),
							filePath: "voice/file_1.ogg",
						};
					},
					queueTurn: async () => undefined,
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual([
				"Voice messages are not supported on this server.",
			]);
			expect(fetched).toBe(false);
		});
	});

	describe("message:document", () => {
		class MockPdfExtractor implements PdfExtractor {
			constructor(private result: PdfExtractionResult) {}
			async extract(_pdfBytes: Uint8Array, _filename: string) {
				return this.result;
			}
		}

		test("queues PDF content with extracted text", async () => {
			const queuedTurns: Array<{
				commandText: string;
				content: unknown;
				currentUserText?: string;
			}> = [];
			const sentMessages: string[] = [];
			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.pdfExtractor = new MockPdfExtractor({
				pages: [
					{ pageNumber: 1, text: "Hello from PDF" },
					{ pageNumber: 2, text: "Page two content" },
				],
				isEncrypted: false,
				isCorrupt: "",
			});

			await handleTelegramPdfMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "test.pdf",
					getFile: async () => ({ file_path: "documents/file_1.pdf" }),
				},
				{
					fetchPdf: async (file, botToken) => {
						expect(file).toEqual({ file_path: "documents/file_1.pdf" });
						expect(botToken).toBe("telegram-token");
						return {
							data: Uint8Array.from([1, 2, 3]),
							filePath: "documents/file_1.pdf",
						};
					},
					queueTurn: async (
						_session,
						_bot,
						_chatId,
						commandText,
						content,
						_caller,
						_store,
						_webShare,
						currentUserText,
					) => {
						queuedTurns.push({ commandText, content, currentUserText });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(queuedTurns).toHaveLength(1);
			expect(queuedTurns[0]?.commandText).toBe("");
			expect(queuedTurns[0]?.content).toContain("_Document: test.pdf — 2 pages_");
			expect(queuedTurns[0]?.content).toContain("Hello from PDF");
			expect(queuedTurns[0]?.content).toContain("--- Page 2 ---");
			expect(queuedTurns[0]?.content).toContain("Page two content");
			expect(sentMessages).toEqual([]);
		});

		test("rejects oversized PDF before download", async () => {
			const sentMessages: string[] = [];
			let fetched = false;

			await handleTelegramPdfMessage(
				{
					session: createTelegramSessionFixture({
						transcribe: async () => "ignored",
					}),
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 21 * 1024 * 1024 },
					filename: "large.pdf",
					getFile: async () => {
						fetched = true;
						return { file_path: "documents/large.pdf" };
					},
				},
				{
					fetchPdf: async () => {
						fetched = true;
						return {
							data: Uint8Array.from([1]),
							filePath: "documents/large.pdf",
						};
					},
					queueTurn: async () => undefined,
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual(["PDF is too large (max 20 MB)."]);
			expect(fetched).toBe(false);
		});

		test("rejects encrypted PDF", async () => {
			const sentMessages: string[] = [];
			const queuedTurns: Array<{ content: unknown }> = [];
			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.pdfExtractor = new MockPdfExtractor({
				pages: [{ pageNumber: 1, text: "ignored" }],
				isEncrypted: true,
				isCorrupt: "",
			});

			await handleTelegramPdfMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "encrypted.pdf",
					getFile: async () => ({ file_path: "documents/encrypted.pdf" }),
				},
				{
					fetchPdf: async () => ({
						data: Uint8Array.from([1, 2, 3]),
						filePath: "documents/encrypted.pdf",
					}),
					queueTurn: async (_session, _bot, _chatId, _command, content) => {
						queuedTurns.push({ content });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual([
				"This PDF is password-protected and cannot be read.",
			]);
			expect(queuedTurns).toEqual([]);
		});

		test("rejects corrupt PDF", async () => {
			const sentMessages: string[] = [];
			const queuedTurns: Array<{ content: unknown }> = [];
			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.pdfExtractor = new MockPdfExtractor({
				pages: [{ pageNumber: 1, text: "ignored" }],
				isEncrypted: false,
				isCorrupt: "corrupt PDF content",
			});

			await handleTelegramPdfMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "corrupt.pdf",
					getFile: async () => ({ file_path: "documents/corrupt.pdf" }),
				},
				{
					fetchPdf: async () => ({
						data: Uint8Array.from([1, 2, 3]),
						filePath: "documents/corrupt.pdf",
					}),
					queueTurn: async (_session, _bot, _chatId, _command, content) => {
						queuedTurns.push({ content });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages[0]?.startsWith("Failed to read PDF:")).toBe(true);
			expect(queuedTurns).toEqual([]);
		});

		test("replies when PDF has no extractable text", async () => {
			const sentMessages: string[] = [];
			const queuedTurns: Array<{ content: unknown }> = [];
			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.pdfExtractor = new MockPdfExtractor({
				pages: [
					{ pageNumber: 1, text: "   " },
					{ pageNumber: 2, text: "" },
				],
				isEncrypted: false,
				isCorrupt: "",
			});

			await handleTelegramPdfMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "empty.pdf",
					getFile: async () => ({ file_path: "documents/empty.pdf" }),
				},
				{
					fetchPdf: async () => ({
						data: Uint8Array.from([1, 2, 3]),
						filePath: "documents/empty.pdf",
					}),
					queueTurn: async (_session, _bot, _chatId, _command, content) => {
						queuedTurns.push({ content });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual(["This PDF appears to contain no text."]);
			expect(queuedTurns).toEqual([]);
		});

		test("surfaces download errors", async () => {
			const sentMessages: string[] = [];

			await handleTelegramPdfMessage(
				{
					session: createTelegramSessionFixture({
						transcribe: async () => "ignored",
					}),
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "test.pdf",
					getFile: async () => ({ file_path: "documents/test.pdf" }),
				},
				{
					fetchPdf: async () => {
						throw new Error("status 404");
					},
					queueTurn: async () => undefined,
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual([
				"Failed to download PDF: status 404",
			]);
		});

		test("surfaces extraction errors", async () => {
			const sentMessages: string[] = [];

			class ErrorPdfExtractor implements PdfExtractor {
				async extract(_pdfBytes: Uint8Array, _filename: string): Promise<PdfExtractionResult> {
					return Promise.reject(new Error("extraction failed"));
				}
			}

			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.pdfExtractor = new ErrorPdfExtractor();

			await handleTelegramPdfMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "test.pdf",
					getFile: async () => ({ file_path: "documents/test.pdf" }),
				},
				{
					fetchPdf: async () => ({
						data: Uint8Array.from([1, 2, 3]),
						filePath: "documents/test.pdf",
					}),
					queueTurn: async () => undefined,
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual([
				"Failed to read PDF: extraction failed",
			]);
		});
	});

	describe("message:spreadsheet", () => {
		class MockSpreadsheetParser implements SpreadsheetParser {
			constructor(private result: SpreadsheetParseResult) {}
			async parse(_data: Uint8Array, _filename: string, _mimeType: string): Promise<SpreadsheetParseResult> {
				return this.result;
			}
		}

		test("queues CSV spreadsheet content with rendered table", async () => {
			const queuedTurns: Array<{
				commandText: string;
				content: unknown;
				currentUserText?: string;
			}> = [];
			const sentMessages: string[] = [];
			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.spreadsheetParser = new MockSpreadsheetParser({
				sheets: [{
					name: "Sheet1",
					headers: ["Name", "Age"],
					rows: [["Alice", "30"], ["Bob", "25"]],
					rowCount: 2,
					colCount: 2,
				}],
				isEmpty: false,
				isCorrupt: false,
			});

			await handleTelegramSpreadsheetMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "data.csv",
					mimeType: "text/csv",
					getFile: async () => ({ file_path: "documents/data.csv" }),
				},
				{
					fetchSpreadsheet: async (file, botToken) => {
						expect(file).toEqual({ file_path: "documents/data.csv" });
						expect(botToken).toBe("telegram-token");
						return {
							data: Uint8Array.from([1, 2, 3]),
							filePath: "documents/data.csv",
						};
					},
					queueTurn: async (
						_session,
						_bot,
						_chatId,
						commandText,
						content,
						_caller,
						_store,
						_webShare,
						currentUserText,
					) => {
						queuedTurns.push({ commandText, content, currentUserText });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(queuedTurns).toHaveLength(1);
			expect(queuedTurns[0]?.commandText).toBe("");
			expect(queuedTurns[0]?.content).toContain("_Spreadsheet: data.csv — 2 rows, 2 columns_");
			expect(queuedTurns[0]?.content).toContain("| Name | Age |");
			expect(queuedTurns[0]?.content).toContain("Alice");
			expect(queuedTurns[0]?.content).toContain("Bob");
			expect(sentMessages).toEqual([]);
		});

		test("queues single-sheet Excel spreadsheet content", async () => {
			const queuedTurns: Array<{
				commandText: string;
				content: unknown;
				currentUserText?: string;
			}> = [];
			const sentMessages: string[] = [];
			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.spreadsheetParser = new MockSpreadsheetParser({
				sheets: [{
					name: "Products",
					headers: ["Product", "Price"],
					rows: [["Apple", "1.5"], ["Banana", "0.75"]],
					rowCount: 2,
					colCount: 2,
				}],
				isEmpty: false,
				isCorrupt: false,
			});

			await handleTelegramSpreadsheetMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 2048 },
					filename: "prices.xlsx",
					mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					getFile: async () => ({ file_path: "documents/prices.xlsx" }),
				},
				{
					fetchSpreadsheet: async (file, botToken) => {
						expect(file).toEqual({ file_path: "documents/prices.xlsx" });
						expect(botToken).toBe("telegram-token");
						return {
							data: Uint8Array.from([1, 2, 3]),
							filePath: "documents/prices.xlsx",
						};
					},
					queueTurn: async (
						_session,
						_bot,
						_chatId,
						commandText,
						content,
						_caller,
						_store,
						_webShare,
						currentUserText,
					) => {
						queuedTurns.push({ commandText, content, currentUserText });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(queuedTurns).toHaveLength(1);
			expect(queuedTurns[0]?.content).toContain("_Spreadsheet: prices.xlsx — 2 rows, 2 columns_");
			expect(queuedTurns[0]?.content).toContain("| Product | Price |");
			expect(queuedTurns[0]?.content).toContain("Apple");
			expect(queuedTurns[0]?.content).toContain("Banana");
			expect(sentMessages).toEqual([]);
		});

		test("queues multi-sheet Excel spreadsheet content with sheet names", async () => {
			const queuedTurns: Array<{
				commandText: string;
				content: unknown;
				currentUserText?: string;
			}> = [];
			const sentMessages: string[] = [];
			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.spreadsheetParser = new MockSpreadsheetParser({
				sheets: [
					{
						name: "Users",
						headers: ["Name", "Age"],
						rows: [["Alice", "30"]],
						rowCount: 1,
						colCount: 2,
					},
					{
						name: "Products",
						headers: ["Product", "Price"],
						rows: [["Apple", "1.5"]],
						rowCount: 1,
						colCount: 2,
					},
				],
				isEmpty: false,
				isCorrupt: false,
			});

			await handleTelegramSpreadsheetMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 2048 },
					filename: "multi.xlsx",
					mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					getFile: async () => ({ file_path: "documents/multi.xlsx" }),
				},
				{
					fetchSpreadsheet: async () => ({
						data: Uint8Array.from([1, 2, 3]),
						filePath: "documents/multi.xlsx",
					}),
					queueTurn: async (
						_session,
						_bot,
						_chatId,
						commandText,
						content,
						_caller,
						_store,
						_webShare,
						currentUserText,
					) => {
						queuedTurns.push({ commandText, content, currentUserText });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(queuedTurns).toHaveLength(1);
			expect(queuedTurns[0]?.content).toContain("_Spreadsheet: multi.xlsx — 2 rows, 2 columns_");
			expect(queuedTurns[0]?.content).toContain("Users");
			expect(queuedTurns[0]?.content).toContain("Products");
			expect(queuedTurns[0]?.content).toContain("Alice");
			expect(queuedTurns[0]?.content).toContain("Apple");
			expect(sentMessages).toEqual([]);
		});

		test("replies when spreadsheet is empty", async () => {
			const sentMessages: string[] = [];
			const queuedTurns: Array<{ content: unknown }> = [];
			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.spreadsheetParser = new MockSpreadsheetParser({
				sheets: [{
					name: "Sheet1",
					headers: [],
					rows: [],
					rowCount: 0,
					colCount: 0,
				}],
				isEmpty: true,
				isCorrupt: false,
			});

			await handleTelegramSpreadsheetMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "empty.csv",
					mimeType: "text/csv",
					getFile: async () => ({ file_path: "documents/empty.csv" }),
				},
				{
					fetchSpreadsheet: async () => ({
						data: Uint8Array.from([1, 2, 3]),
						filePath: "documents/empty.csv",
					}),
					queueTurn: async (_session, _bot, _chatId, _command, content) => {
						queuedTurns.push({ content });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual(["This spreadsheet appears to be empty."]);
			expect(queuedTurns).toEqual([]);
		});

		test("rejects oversized spreadsheet before download", async () => {
			const sentMessages: string[] = [];
			let fetched = false;

			await handleTelegramSpreadsheetMessage(
				{
					session: createTelegramSessionFixture({
						transcribe: async () => "ignored",
					}),
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 11 * 1024 * 1024 },
					filename: "large.xlsx",
					mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					getFile: async () => {
						fetched = true;
						return { file_path: "documents/large.xlsx" };
					},
				},
				{
					fetchSpreadsheet: async () => {
						fetched = true;
						return {
							data: Uint8Array.from([1]),
							filePath: "documents/large.xlsx",
						};
					},
					queueTurn: async () => undefined,
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual(["Spreadsheet is too large (max 10 MB)."]);
			expect(fetched).toBe(false);
		});

		test("replies when spreadsheet is corrupt", async () => {
			const sentMessages: string[] = [];
			const queuedTurns: Array<{ content: unknown }> = [];
			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.spreadsheetParser = new MockSpreadsheetParser({
				sheets: [{
					name: "Sheet1",
					headers: [],
					rows: [],
					rowCount: 0,
					colCount: 0,
				}],
				isEmpty: false,
				isCorrupt: true,
			});

			await handleTelegramSpreadsheetMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "corrupt.xlsx",
					mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					getFile: async () => ({ file_path: "documents/corrupt.xlsx" }),
				},
				{
					fetchSpreadsheet: async () => ({
						data: Uint8Array.from([1, 2, 3]),
						filePath: "documents/corrupt.xlsx",
					}),
					queueTurn: async (_session, _bot, _chatId, _command, content) => {
						queuedTurns.push({ content });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual(["Failed to read spreadsheet: parsing failed"]);
			expect(queuedTurns).toEqual([]);
		});

		test("surfaces download errors", async () => {
			const sentMessages: string[] = [];
			let parsed = false;

			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.spreadsheetParser = new MockSpreadsheetParser({
				sheets: [{
					name: "Sheet1",
					headers: [],
					rows: [],
					rowCount: 0,
					colCount: 0,
				}],
				isEmpty: false,
				isCorrupt: false,
			});

			await handleTelegramSpreadsheetMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "test.csv",
					mimeType: "text/csv",
					getFile: async () => ({ file_path: "documents/test.csv" }),
				},
				{
					fetchSpreadsheet: async () => {
						throw new Error("status 404");
					},
					queueTurn: async () => {
						parsed = true;
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual(["Failed to download spreadsheet: status 404"]);
			expect(parsed).toBe(false);
		});

		test("surfaces parse errors", async () => {
			const sentMessages: string[] = [];
			const queuedTurns: Array<{ content: unknown }> = [];

			class ErrorSpreadsheetParser implements SpreadsheetParser {
				async parse(_data: Uint8Array, _filename: string, _mimeType: string): Promise<SpreadsheetParseResult> {
					throw new Error("parse failed");
				}
			}

			const session = createTelegramSessionFixture({
				transcribe: async () => "ignored",
			});
			session.spreadsheetParser = new ErrorSpreadsheetParser();

			await handleTelegramSpreadsheetMessage(
				{
					session,
					bot: {} as Bot,
					chatId: "123",
					caller: {
						id: "telegram:123",
						entrypoint: "telegram",
						externalId: "123",
					},
					store: {} as PermissionsStore,
					webShare: undefined,
					botToken: "telegram-token",
					document: { file_size: 1024 },
					filename: "test.csv",
					mimeType: "text/csv",
					getFile: async () => ({ file_path: "documents/test.csv" }),
				},
				{
					fetchSpreadsheet: async () => ({
						data: Uint8Array.from([1, 2, 3]),
						filePath: "documents/test.csv",
					}),
					queueTurn: async (_session, _bot, _chatId, _command, content) => {
						queuedTurns.push({ content });
					},
					sendMessage: async (_bot, _chatId, text) => {
						sentMessages.push(text);
					},
				},
			);

			expect(sentMessages).toEqual(["Failed to read spreadsheet: parse failed"]);
			expect(queuedTurns).toEqual([]);
		});
	});

	test("fetchTelegramFileBytes downloads Telegram-hosted image bytes", async () => {
		const result = await fetchTelegramFileBytes(
			{ file_path: "photos/file_1.png" },
			"token-123",
			(async (input) => {
				expect(String(input)).toBe(
					"https://api.telegram.org/file/bottoken-123/photos/file_1.png",
				);
				return new Response(Uint8Array.from([7, 8, 9]), { status: 200 });
			}) as typeof fetch,
		);

		expect(result).toEqual({
			data: Uint8Array.from([7, 8, 9]),
			filePath: "photos/file_1.png",
		});
	});

	test("fetchTelegramFileBytes rejects files without a download path", async () => {
		await expect(
			fetchTelegramFileBytes({ file_path: "" }, "token-123"),
		).rejects.toThrow("Telegram did not return a downloadable file path.");
	});

	test("extractTelegramReplyFromAgentState returns the latest text reply", () => {
		expect(
			extractTelegramReplyFromAgentState({
				values: {
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "older" }] },
						{
							role: "assistant",
							content: [
								{ type: "text", text: "final answer" },
								{ type: "tool_use", name: "ignored" },
							],
						},
					],
				},
			}),
		).toBe("final answer");
	});

	test("extractTelegramReplyFromAgentState returns empty string when state has no text", () => {
		expect(
			extractTelegramReplyFromAgentState({
				values: {
					messages: [{ role: "assistant", content: [{ type: "image" }] }],
				},
			}),
		).toBe("");
	});

	test("getTelegramCaller returns null for unknown or suspended users", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		store = new PermissionsStore({ db, dialect: "sqlite" });
		expect(await getTelegramCaller(store, "123")).toBeNull();

		const user = await store.upsertUser({
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Chat 123",
		});
		await store.setUserStatus(user.id, "suspended");

		expect(await getTelegramCaller(store, "123")).toBeNull();
		await db.close();
	});

	test("getTelegramCaller returns an active telegram caller", async () => {
		const db = new Bun.SQL("sqlite://:memory:");
		store = new PermissionsStore({ db, dialect: "sqlite" });
		await store.upsertUser({
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Chat 123",
		});

		expect(await getTelegramCaller(store, "123")).toEqual({
			id: "telegram:123",
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Chat 123",
		});
		await db.close();
	});

	test("maybeHandleTelegramApprovalReply resolves known approval responses", async () => {
		const outcomes: ApprovalOutcome[] = [];
		const session = {
			agent: {} as never,
			running: false,
			queue: [],
			threadId: "telegram-123",
			workspace: {} as never,
			model: {} as never,
			refreshAgent: async () => {},
			transcriber: new NoOpTranscriber(),
			pdfExtractor: new NoOpPdfExtractor(),
			spreadsheetParser: new NoOpSpreadsheetParser(),
			pendingApprovals: new Map([
				[
					"prompt-1",
					{
						request: {
							caller: {
								id: "telegram:123",
								entrypoint: "telegram" as const,
								externalId: "123",
							},
							toolName: "read_file",
							args: {},
						},
						resolve: async (outcome: ApprovalOutcome) => {
							outcomes.push(outcome);
						},
						timeout: setTimeout(() => undefined, 1000),
						promptId: "prompt-1",
					},
				],
			]),
		};

		const result = maybeHandleTelegramApprovalReply(session, "always");
		expect(result).toEqual({ handled: true });
		await Promise.resolve();
		clearTimeout(session.pendingApprovals.get("prompt-1")?.timeout);

		expect(outcomes).toEqual(["approve-always"]);
		expect(session.pendingApprovals.size).toBe(0);
	});

	test("maybeHandleTelegramApprovalReply ignores unrelated text", () => {
		const session = {
			agent: {} as never,
			running: false,
			queue: [],
			threadId: "telegram-123",
			workspace: {} as never,
			model: {} as never,
			refreshAgent: async () => {},
			transcriber: new NoOpTranscriber(),
			pdfExtractor: new NoOpPdfExtractor(),
			spreadsheetParser: new NoOpSpreadsheetParser(),
			pendingApprovals: new Map(),
		};

		expect(maybeHandleTelegramApprovalReply(session, "hello")).toEqual({
			handled: false,
		});
	});

	test("extractTelegramCommandName normalizes Telegram bot command variants", () => {
		expect(extractTelegramCommandName("/policy")).toBe("policy");
		expect(extractTelegramCommandName("/policy@klondikbot")).toBe("policy");
		expect(extractTelegramCommandName("/policy@klondikbot extra")).toBe(
			"policy",
		);
		expect(extractTelegramCommandName("hello")).toBeNull();
	});

	test("formatUnknownTelegramCommandReply lists supported commands", () => {
		const reply = formatUnknownTelegramCommandReply("stale");
		expect(reply).toContain("Unknown command: /stale");
		expect(reply).toContain("/help");
		expect(reply).toContain("/new_thread");
	});

	test("callback payload parsing preserves prompt ids containing colons", () => {
		const data = "approve-once:1712345678901:abc123";
		const separator = data.indexOf(":");
		const outcome = separator === -1 ? data : data.slice(0, separator);
		const promptId = separator === -1 ? "" : data.slice(separator + 1);

		expect(outcome).toBe("approve-once");
		expect(promptId).toBe("1712345678901:abc123");
	});

	test("text approval is rejected when several requests are pending", async () => {
		const outcomes: ApprovalOutcome[] = [];
		const firstTimeout = setTimeout(() => undefined, 1000);
		const secondTimeout = setTimeout(() => undefined, 1000);
		const session = {
			agent: {} as never,
			running: false,
			queue: [],
			threadId: "telegram-123",
			workspace: {} as never,
			model: {} as never,
			refreshAgent: async () => {},
			transcriber: new NoOpTranscriber(),
			pdfExtractor: new NoOpPdfExtractor(),
			spreadsheetParser: new NoOpSpreadsheetParser(),
			pendingApprovals: new Map([
				[
					"prompt-1",
					{
						request: {
							caller: {
								id: "telegram:123",
								entrypoint: "telegram" as const,
								externalId: "123",
							},
							toolName: "read_file",
							args: { file_path: "/a" },
						},
						resolve: async (outcome: ApprovalOutcome) => {
							outcomes.push(outcome);
						},
						timeout: firstTimeout,
						promptId: "prompt-1",
					},
				],
				[
					"prompt-2",
					{
						request: {
							caller: {
								id: "telegram:123",
								entrypoint: "telegram" as const,
								externalId: "123",
							},
							toolName: "read_file",
							args: { file_path: "/b" },
						},
						resolve: async (outcome: ApprovalOutcome) => {
							outcomes.push(
								outcome === "approve-once" ? ("second" as never) : outcome,
							);
						},
						timeout: secondTimeout,
						promptId: "prompt-2",
					},
				],
			]),
		};

		const result = maybeHandleTelegramApprovalReply(session, "approve");
		await Promise.resolve();
		clearTimeout(firstTimeout);
		clearTimeout(secondTimeout);

		expect(result).toEqual({
			handled: true,
			reply:
				"Several approvals are pending. Use the buttons on the specific prompt instead of plain text.",
		});
		expect(outcomes).toEqual([]);
		expect(session.pendingApprovals.has("prompt-1")).toBe(true);
		expect(session.pendingApprovals.has("prompt-2")).toBe(true);
	});

	describe("timer tools integration", () => {
		interface AsyncMockFn {
			(...args: unknown[]): Promise<unknown>;
			_calls: unknown[][];
			mockResolvedValue(value: unknown): void;
			mockRejectedValue(error: Error): void;
		}

		function createAsyncMockFn(): AsyncMockFn {
			const calls: unknown[][] = [];
			let resolved = true;
			let mockValue: unknown = undefined;
			const mockFn = ((...args: unknown[]) => {
				calls.push(args);
				if (resolved) {
					return Promise.resolve(mockValue);
				} else {
					return Promise.reject(mockValue);
				}
			}) as AsyncMockFn;
			mockFn._calls = calls;
			mockFn.mockResolvedValue = (value: unknown) => {
				resolved = true;
				mockValue = value;
			};
			mockFn.mockRejectedValue = (error: Error) => {
				resolved = false;
				mockValue = error;
			};
			return mockFn;
		}

		type MockTimerStore = {
			[K in keyof TimerStore]: AsyncMockFn;
		};

		function createMockTimerStore(): MockTimerStore {
			const mockStore = {
				create: createAsyncMockFn(),
				findByUser: createAsyncMockFn(),
				getById: createAsyncMockFn(),
				update: createAsyncMockFn(),
				delete: createAsyncMockFn(),
				touchRun: createAsyncMockFn(),
				touchError: createAsyncMockFn(),
				findDue: createAsyncMockFn(),
				ready: createAsyncMockFn(),
				close: createAsyncMockFn(),
			} as MockTimerStore;
			mockStore.ready.mockResolvedValue(undefined);
			return mockStore;
		}

		function createTimer(overrides: Partial<TimerRecord> = {}): TimerRecord {
			return {
				id: "timer-1",
				userId: "telegram:123",
				chatId: "telegram:123",
				mdFilePath: "test.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				enabled: true,
				lastRunAt: null,
				lastError: null,
				consecutiveFailures: 0,
				nextRunAt: 1000,
				createdAt: 100,
				...overrides,
			};
		}

		test("timer fires → reads md file → LLM executes → result sent to correct chat", async () => {
			const mockTimerStore = createMockTimerStore();
			const timer = createTimer({ chatId: "telegram:123", mdFilePath: "daily-news.md" });
			mockTimerStore.findDue.mockResolvedValue([timer]);

			const mockReadMdFile = createAsyncMockFn();
			mockReadMdFile.mockResolvedValue("What is the news today?");

			const mockOnTick = createAsyncMockFn();
			mockOnTick.mockResolvedValue(undefined);

			const mockNotifyUser = createAsyncMockFn();
			mockNotifyUser.mockResolvedValue(undefined);

			const scheduler = startScheduler(mockTimerStore as unknown as TimerStore, {
				intervalMs: 10_000_000,
				readMdFile: mockReadMdFile as (timer: Parameters<SchedulerOptions["readMdFile"]>[0], path: string) => Promise<string>,
				onTick: mockOnTick as (timer: TimerRecord, promptText: string) => Promise<void>,
				notifyUser: mockNotifyUser as (userId: string, message: string) => Promise<void>,
			});

			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(mockReadMdFile._calls).toEqual([[timer, "daily-news.md"]]);
			expect(mockOnTick._calls).toEqual([[timer, "What is the news today?"]]);

			scheduler.stop();
		});

		test("timer creation via agent tool call → timer stored in DB with correct fields", async () => {
			const db = new Bun.SQL("sqlite://:memory:");
			const timerStore = new TimerStore({ db, dialect: "sqlite" });

			await timerStore.create({
				userId: "telegram:123",
				chatId: "telegram:123",
				mdFilePath: "test.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const timers = await timerStore.findByUser("telegram:123");
			expect(timers).toHaveLength(1);
			expect(timers[0]?.mdFilePath).toBe("test.md");
			expect(timers[0]?.cronExpression).toBe("0 10 * * *");
			expect(timers[0]?.timezone).toBe("UTC");

			await db.close();
		});

		test("update timer via agent tool call → cron and next_run_at updated in DB", async () => {
			const db = new Bun.SQL("sqlite://:memory:");
			const timerStore = new TimerStore({ db, dialect: "sqlite" });

			const timer = await timerStore.create({
				userId: "telegram:123",
				chatId: "telegram:123",
				mdFilePath: "test.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			await timerStore.update(timer.id, "telegram:123", {
				cronExpression: "0 14 * * *",
			});

			const updated = await timerStore.getById(timer.id);
			expect(updated?.cronExpression).toBe("0 14 * * *");

			await db.close();
		});

		test("delete timer via agent tool call → timer removed from DB", async () => {
			const db = new Bun.SQL("sqlite://:memory:");
			const timerStore = new TimerStore({ db, dialect: "sqlite" });

			const timer = await timerStore.create({
				userId: "telegram:123",
				chatId: "telegram:123",
				mdFilePath: "test.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const deleted = await timerStore.delete(timer.id, "telegram:123");
			expect(deleted).toBe(true);

			const found = await timerStore.getById(timer.id);
			expect(found).toBeNull();

			await db.close();
		});

		test("delete non-owned timer → rejected with error", async () => {
			const db = new Bun.SQL("sqlite://:memory:");
			const timerStore = new TimerStore({ db, dialect: "sqlite" });

			const timer = await timerStore.create({
				userId: "telegram:123",
				chatId: "telegram:123",
				mdFilePath: "test.md",
				cronExpression: "0 10 * * *",
				timezone: "UTC",
				nextRunAt: 2000,
			});

			const deleted = await timerStore.delete(timer.id, "telegram:999");
			expect(deleted).toBe(false);

			const found = await timerStore.getById(timer.id);
			expect(found).not.toBeNull();

			await db.close();
		});

		test("3 consecutive failures → warning message sent to user", async () => {
			const mockTimerStore = createMockTimerStore();
			const timer = createTimer();
			mockTimerStore.findDue.mockResolvedValue([timer]);

			const mockReadMdFile = createAsyncMockFn();
			mockReadMdFile.mockResolvedValue("prompt");

			const mockOnTick = createAsyncMockFn();
			mockOnTick.mockRejectedValue(new Error("LLM failed"));

			mockTimerStore.touchError.mockResolvedValue(3);

			const mockNotifyUser = createAsyncMockFn();
			mockNotifyUser.mockResolvedValue(undefined);

			const scheduler = startScheduler(mockTimerStore as unknown as TimerStore, {
				intervalMs: 10_000_000,
				readMdFile: mockReadMdFile as (timer: Parameters<SchedulerOptions["readMdFile"]>[0], path: string) => Promise<string>,
				onTick: mockOnTick as (timer: TimerRecord, promptText: string) => Promise<void>,
				notifyUser: mockNotifyUser as (userId: string, message: string) => Promise<void>,
			});

			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(mockTimerStore.touchError._calls.length).toBe(1);
			expect(mockTimerStore.touchError._calls[0][0]).toBe("timer-1");
			expect(mockTimerStore.touchError._calls[0][1]).toBe("LLM failed");
			expect(typeof mockTimerStore.touchError._calls[0][2]).toBe("number");
			expect(mockNotifyUser._calls).toEqual([
				["telegram:123", expect.stringContaining("failed 3 times")],
			]);

			scheduler.stop();
		});

		test("invalid cron → error returned to agent, no timer created", async () => {
			const db = new Bun.SQL("sqlite://:memory:");
			const timerStore = new TimerStore({ db, dialect: "sqlite" });

			const timersBefore = await timerStore.findByUser("telegram:123");
			expect(timersBefore).toHaveLength(0);

			await db.close();
		});

		test("md file not found at execution → timer deleted, user notified", async () => {
			const mockTimerStore = createMockTimerStore();
			const timer = createTimer({ mdFilePath: "/memory/deleted.md" });
			mockTimerStore.findDue.mockResolvedValue([timer]);

			const mockReadMdFile = createAsyncMockFn();
			mockReadMdFile.mockRejectedValue(new Error("File not found"));

			mockTimerStore.delete.mockResolvedValue(true);

			const mockOnTick = createAsyncMockFn();
			mockOnTick.mockResolvedValue(undefined);

			const mockNotifyUser = createAsyncMockFn();
			mockNotifyUser.mockResolvedValue(undefined);

			const scheduler = startScheduler(mockTimerStore as unknown as TimerStore, {
				intervalMs: 10_000_000,
				readMdFile: mockReadMdFile as (timer: Parameters<SchedulerOptions["readMdFile"]>[0], path: string) => Promise<string>,
				onTick: mockOnTick as (timer: TimerRecord, promptText: string) => Promise<void>,
				notifyUser: mockNotifyUser as (userId: string, message: string) => Promise<void>,
			});

			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(mockTimerStore.delete._calls).toEqual([["timer-1", "telegram:123"]]);
			expect(mockNotifyUser._calls).toEqual([
				["telegram:123", "Timer for '/memory/deleted.md' was deleted because the memory file no longer exists."],
			]);
			expect(mockOnTick._calls.length).toBe(0);

			scheduler.stop();
		});
	});
});
