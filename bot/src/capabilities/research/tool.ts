import { GraphRecursionError } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "langchain";
import { z } from "zod";
import type { WorkspaceBackend } from "../../backends/types";
import type { SupportedLocale } from "../../i18n/locale";
import type { BrowserSessionManager } from "../../tools/browser_session_manager";
import type { StatusEmitter } from "../../tools/status_emitter";
import { estimateAttachmentTokens } from "../attachment_budget";
import {
	buildResearchAgent,
	type BuildResearchAgentOptions,
	type TabularEngine,
} from "./agent";
import { mintId, ResearchNotes } from "./notes";
import { depthToRecursionLimit } from "./prompts";

const NOTES_DIR = "research";
const MAX_SUMMARY_TOKENS = 2000;

type AgentLike = {
	invoke(
		input: unknown,
		config: unknown,
	): Promise<{ messages?: unknown[] }>;
};

type AgentFactory = (options: BuildResearchAgentOptions) => AgentLike;

export interface CreateResearchToolOptions {
	model: BaseChatModel;
	workspace: WorkspaceBackend;
	browserManager: BrowserSessionManager;
	statusEmitter?: StatusEmitter;
	locale?: SupportedLocale;
	tabularEngine?: TabularEngine;
	/** Override the agent factory — for testing only. */
	_buildAgent?: AgentFactory;
}

function extractFinalText(result: { messages?: unknown[] }): string {
	const messages = result.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (typeof msg !== "object" || msg === null) continue;
		const getType = (msg as { getType?: () => string }).getType;
		const msgType =
			typeof getType === "function" ? getType.call(msg) : "";
		if (msgType !== "ai" && msgType !== "assistant") continue;
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string" && content.trim()) return content.trim();
		if (Array.isArray(content)) {
			const text = content
				.filter(
					(p: unknown) =>
						typeof p === "object" &&
						p !== null &&
						(p as { type?: string }).type === "text",
				)
				.map((p: unknown) => (p as { text?: string }).text ?? "")
				.join("")
				.trim();
			if (text) return text;
		}
	}
	return "Research completed but no text summary was returned.";
}

function buildBrief(
	question: string,
	hints?: string[],
	inputs?: string[],
): string {
	const parts: string[] = [`Question: ${question}`];
	if (hints && hints.length > 0) {
		parts.push(`Hints:\n${hints.map((h) => `- ${h}`).join("\n")}`);
	}
	if (inputs && inputs.length > 0) {
		parts.push(
			`Workspace input files:\n${inputs.map((p) => `- ${p}`).join("\n")}`,
		);
	}
	return parts.join("\n\n");
}

async function maybeShortenSummary(
	summary: string,
	model: BaseChatModel,
	notesPath: string,
): Promise<string> {
	const tokenCount = estimateAttachmentTokens({
		content: summary,
		currentUserText: "",
	});
	if (tokenCount <= MAX_SUMMARY_TOKENS) return summary;

	try {
		const response = await model.invoke([
			{
				role: "user",
				content: `Condense the following research summary to under ${MAX_SUMMARY_TOKENS} tokens. Return only the condensed text.\n\n${summary}`,
			},
		]);
		const shorterText =
			typeof response.content === "string"
				? response.content
				: Array.isArray(response.content)
					? (
							response.content as Array<{
								type?: string;
								text?: string;
							}>
						)
							.filter((p) => p.type === "text")
							.map((p) => p.text ?? "")
							.join("")
					: "";
		const shorterTrimmed = shorterText.trim();
		if (shorterTrimmed) {
			const shorterTokens = estimateAttachmentTokens({
				content: shorterTrimmed,
				currentUserText: "",
			});
			if (shorterTokens <= MAX_SUMMARY_TOKENS) return shorterTrimmed;
		}
	} catch {
		// fall through to truncation
	}

	const maxChars = MAX_SUMMARY_TOKENS * 4;
	const truncated = summary.slice(0, maxChars);
	return `${truncated}\n\n[Summary truncated. Full research notes at ${notesPath}]`;
}

export function createResearchTool(options: CreateResearchToolOptions) {
	const {
		model,
		workspace,
		browserManager,
		tabularEngine,
		_buildAgent = buildResearchAgent as AgentFactory,
	} = options;

	return tool(
		async ({
			question,
			hints,
			inputs,
			depth,
		}: {
			question: string;
			hints?: string[];
			inputs?: string[];
			depth?: "quick" | "standard" | "deep";
		}) => {
			const runId = mintId();
			const notes = new ResearchNotes();
			const notesPath = `${NOTES_DIR}/${runId}.md`;

			const agent = _buildAgent({
				model,
				workspace,
				browserManager,
				callerId: "research",
				runId,
				notes,
				tabularEngine,
			});

			const brief = buildBrief(question, hints, inputs);
			const recursionLimit = depthToRecursionLimit(depth);

			let summary: string;
			try {
				const result = await agent.invoke(
					{ messages: [{ role: "user", content: brief }] },
					{
						recursionLimit,
						configurable: { thread_id: runId },
					},
				);
				summary = extractFinalText(
					result as { messages?: unknown[] },
				);
			} catch (err) {
				const isRecursion =
					err instanceof GraphRecursionError ||
					(err instanceof Error &&
						(err.constructor.name === "GraphRecursionError" ||
							err.message.toLowerCase().includes("recursion limit")));
				if (isRecursion) {
					try {
						await workspace.write(notesPath, notes.serializeMarkdown());
					} catch {
						// best effort
					}
					return `Research hit the recursion limit (${recursionLimit} steps). Partial findings saved to ${notesPath}.`;
				}
				throw err;
			}

			await workspace.write(notesPath, notes.serializeMarkdown());
			summary = await maybeShortenSummary(summary, model, notesPath);
			return summary;
		},
		{
			name: "research",
			description:
				"Delegate a research-heavy investigation to a short-lived inner agent. Returns a compact synthesis. Use for questions requiring web browsing, multi-source comparison, or large file analysis.",
			schema: z.object({
				question: z
					.string()
					.describe("The research question to investigate."),
				hints: z
					.array(z.string())
					.optional()
					.describe("Optional hints or context to guide the research."),
				inputs: z
					.array(z.string())
					.optional()
					.describe(
						"Optional workspace file paths relevant to the question.",
					),
				depth: z
					.enum(["quick", "standard", "deep"])
					.optional()
					.describe(
						"Recursion budget: quick (15 steps), standard (40 steps, default), deep (80 steps).",
					),
			}),
		},
	);
}
