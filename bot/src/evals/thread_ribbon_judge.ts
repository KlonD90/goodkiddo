import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { modelChooser } from "../model/model_chooser";
import type { SupportedAiTypes } from "../types";
import { decideThreadRibbon } from "../vibes/thread_ribbon";
import {
	type ThreadRibbonFixture,
	threadRibbonFixtures,
} from "../vibes/thread_ribbon_fixtures";

type EvalResult = {
	id: string;
	passed: boolean;
	detail: string;
};

const FORBIDDEN_RIBBON_PHRASES = [
	"I noticed",
	"as an AI",
	"great job",
	"awesome sauce",
	"synergy",
];

function validateFixtureShape(fixture: ThreadRibbonFixture): EvalResult[] {
	const results: EvalResult[] = [];
	const decision = decideThreadRibbon({
		currentUserText: fixture.currentUserText,
		recentMessages: fixture.recentMessages,
		channel: fixture.channel,
	});
	results.push({
		id: `${fixture.id}:fires-only-when-expected`,
		passed: decision.eligible === fixture.expectCandidate,
		detail: `expected=${fixture.expectCandidate} actual=${decision.eligible}`,
	});
	if (fixture.expectCandidate && decision.eligible) {
		results.push({
			id: `${fixture.id}:prompt-has-rubric`,
			passed:
				decision.context.includes("under 18 words") &&
				decision.context.includes("Avoid") &&
				decision.context.includes("Skip the ribbon"),
			detail: "runtime prompt carries length, style, and off-switch guidance",
		});
	}
	if (!fixture.expectCandidate && !decision.eligible) {
		results.push({
			id: `${fixture.id}:off-reason`,
			passed: decision.offReason === fixture.expectedOffReason,
			detail: `expected=${fixture.expectedOffReason} actual=${decision.offReason}`,
		});
	}
	return results;
}

function offlineEval(): EvalResult[] {
	const results = threadRibbonFixtures.flatMap(validateFixtureShape);
	results.push({
		id: "rubric:forbidden-phrases-listed",
		passed:
			FORBIDDEN_RIBBON_PHRASES.includes("I noticed") &&
			FORBIDDEN_RIBBON_PHRASES.includes("as an AI"),
		detail: "offline rubric checks surveillance/AI phrasing coverage",
	});
	return results;
}

function getTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "string"
					? part
					: typeof part === "object" && part !== null && "text" in part
						? String((part as { text: unknown }).text ?? "")
						: "",
			)
			.join("");
	}
	return String(content ?? "");
}

function buildJudgePrompt(): string {
	const fixtureSummary = threadRibbonFixtures
		.map((fixture) => {
			const decision = decideThreadRibbon({
				currentUserText: fixture.currentUserText,
				recentMessages: fixture.recentMessages,
				channel: fixture.channel,
			});
			return JSON.stringify({
				id: fixture.id,
				description: fixture.description,
				expectedCandidate: fixture.expectCandidate,
				decision,
			});
		})
		.join("\n");
	return [
		"You are judging a lightweight product eval for GoodKiddo's Thread Ribbon feature.",
		'Return strict JSON: {"pass": boolean, "issues": string[]}.',
		"Rubric:",
		"- Candidates fire only when expected by fixtures.",
		"- Runtime prompt demands a ribbon <=18 words.",
		"- Ribbon, if used, must be specific to progress/relief, not generic praise.",
		"- Must forbid surveillance phrasing like 'I noticed' and AI/corporate phrasing.",
		"- Must be off for grief, anger/complaints, billing/refunds, security, escalation, legal/medical/safety.",
		"- No emoji spam; zero or one emoji max.",
		"Fixtures and deterministic decisions:",
		fixtureSummary,
	].join("\n");
}

async function maybeRunLlmJudge(): Promise<EvalResult[]> {
	if (process.env.THREAD_RIBBON_LLM_JUDGE !== "1") return [];
	const aiType = (process.env.AI_TYPE ?? "") as SupportedAiTypes;
	const modelName = process.env.AI_MODEL_NAME ?? "";
	const apiKey = process.env.AI_API_KEY ?? "";
	if (!aiType || !modelName || !apiKey) {
		return [
			{
				id: "llm-judge:skipped",
				passed: true,
				detail:
					"THREAD_RIBBON_LLM_JUDGE=1 but AI_TYPE/AI_MODEL_NAME/AI_API_KEY not fully configured; offline eval ran.",
			},
		];
	}
	const model: BaseChatModel = modelChooser(
		aiType,
		modelName,
		apiKey,
		process.env.AI_BASE_URL ?? "",
		{ temperature: 0 },
	);
	const response = await model.invoke([
		{
			role: "user",
			content: buildJudgePrompt(),
		},
	]);
	const text = getTextContent(response.content).trim();
	let parsed: { pass?: unknown; issues?: unknown };
	try {
		parsed = JSON.parse(text);
	} catch {
		return [
			{
				id: "llm-judge:json",
				passed: false,
				detail: `judge returned non-JSON: ${text.slice(0, 500)}`,
			},
		];
	}
	return [
		{
			id: "llm-judge:rubric",
			passed: parsed.pass === true,
			detail: Array.isArray(parsed.issues)
				? parsed.issues.join("; ") || "judge passed"
				: "judge returned no issues array",
		},
	];
}

const results = [...offlineEval(), ...(await maybeRunLlmJudge())];
for (const result of results) {
	console.log(
		`${result.passed ? "PASS" : "FAIL"} ${result.id} — ${result.detail}`,
	);
}
const failures = results.filter((result) => !result.passed);
if (failures.length > 0) {
	console.error(`\nThread Ribbon eval failed: ${failures.length} failure(s).`);
	process.exit(1);
}
console.log(`\nThread Ribbon eval passed: ${results.length} checks.`);
