import { afterEach, describe, expect, test } from "bun:test";
import type { ApprovalOutcome } from "../permissions/approval";
import { PermissionsStore } from "../permissions/store";
import {
	buildTelegramPhotoContent,
	chunkRenderedTelegramMessages,
	chunkTelegramMessage,
	extractTelegramCommandName,
	extractTelegramReplyFromAgentState,
	fetchTelegramFileBytes,
	formatUnknownTelegramCommandReply,
	getTelegramCaller,
	maybeHandleTelegramApprovalReply,
	renderTelegramHtml,
	takeTelegramStreamChunks,
} from "./telegram";

let store: PermissionsStore;

afterEach(() => {
	store?.close();
});

describe("telegram channel", () => {
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

	test("fetchTelegramFileBytes downloads Telegram-hosted image bytes", async () => {
		const result = await fetchTelegramFileBytes(
			{ file_path: "photos/file_1.png" },
			"token-123",
			async (input) => {
				expect(String(input)).toBe(
					"https://api.telegram.org/file/bottoken-123/photos/file_1.png",
				);
				return new Response(Uint8Array.from([7, 8, 9]), { status: 200 });
			},
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

	test("getTelegramCaller returns null for unknown or suspended users", () => {
		store = new PermissionsStore({ dbPath: ":memory:" });
		expect(getTelegramCaller(store, "123")).toBeNull();

		const user = store.upsertUser({
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Chat 123",
		});
		store.setUserStatus(user.id, "suspended");

		expect(getTelegramCaller(store, "123")).toBeNull();
	});

	test("getTelegramCaller returns an active telegram caller", () => {
		store = new PermissionsStore({ dbPath: ":memory:" });
		store.upsertUser({
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Chat 123",
		});

		expect(getTelegramCaller(store, "123")).toEqual({
			id: "telegram:123",
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Chat 123",
		});
	});

	test("maybeHandleTelegramApprovalReply resolves known approval responses", async () => {
		const outcomes: ApprovalOutcome[] = [];
		const session = {
			agent: {} as never,
			running: false,
			queue: [],
			threadId: "telegram-123",
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
});
