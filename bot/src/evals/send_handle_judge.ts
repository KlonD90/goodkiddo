import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { modelChooser } from "../model/model_chooser";
import type { SupportedAiTypes } from "../types";
import { decideSendHandle, isForbiddenSelfPraise } from "../vibes/send_handle";
import {
	forbiddenSelfPraisePhrases,
	type SendHandleFixture,
	sendHandleFixtures,
} from "../vibes/send_handle_fixtures";

type EvalResult = {
	id: string;
	passed: boolean;
	detail: string;
};

const FORBIDDEN_HANDLE_PHRASES = [
	"I noticed",
	"as an AI",
	"great job",
	"awesome sauce",
	"synergy",
	...forbiddenSelfPraisePhrases,
];

function validateFixtureShape(fixture: SendHandleFixture): EvalResult[] {
	const results: EvalResult[] = [];
	const decision = decideSendHandle({
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
			id: `${fixture.id}:prompt-has-user-owned-rubric`,
			passed:
				decision.context.includes("small practical handhold") &&
				decision.context.includes("user can send, check, trim, or reuse") &&
				decision.context.includes("Do not add self-praise") &&
				decision.context.includes("Skip the handle") &&
				!decision.context.includes("Thread Ribbon"),
			detail:
				"runtime prompt carries user-owned handle, anti-self-praise, and off-switch guidance",
		});
		for (const example of fixture.expectedHandleExamples ?? []) {
			results.push({
				id: `${fixture.id}:golden-example:${example.slice(0, 24)}`,
				passed: decision.context.includes(example),
				detail: "golden practical handle example is present in rubric",
			});
		}
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
	const results = sendHandleFixtures.flatMap(validateFixtureShape);
	for (const phrase of forbiddenSelfPraisePhrases) {
		results.push({
			id: `anti-self-praise:${phrase}`,
			passed: isForbiddenSelfPraise(phrase),
			detail:
				"self-praise regression guard catches rejected Thread Ribbon style",
		});
	}
	results.push({
		id: "rubric:forbidden-phrases-listed",
		passed:
			FORBIDDEN_HANDLE_PHRASES.includes("I noticed") &&
			FORBIDDEN_HANDLE_PHRASES.includes("as an AI") &&
			FORBIDDEN_HANDLE_PHRASES.includes("GoodKiddo solved"),
		detail: "offline rubric checks surveillance/AI/self-praise coverage",
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
	const fixtureSummary = sendHandleFixtures
		.map((fixture) => {
			const decision = decideSendHandle({
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
		"You are judging a lightweight product eval for GoodKiddo's Send Handle feature.",
		'Return strict JSON: {"pass": boolean, "issues": string[]}.',
		"Rubric:",
		"- Candidates fire only when expected by fixtures.",
		"- Runtime prompt allows at most one small practical handhold.",
		"- The handle must be user-owned: a phrase, check, edit, or choice the human can send/check/use.",
		"- Must forbid self-praise/self-congratulation such as Tiny win, we cleaned, thread solved, or GoodKiddo solved.",
		"- Must forbid surveillance phrasing like 'I noticed' and AI/corporate phrasing.",
		"- Must be off for grief, anger/complaints, billing/refunds, security, escalation, legal/medical/safety, and low-signal turns.",
		"- No emoji spam; zero or one emoji max.",
		"Fixtures and deterministic decisions:",
		fixtureSummary,
	].join("\n");
}

async function maybeRunLlmJudge(): Promise<EvalResult[]> {
	if (process.env.SEND_HANDLE_LLM_JUDGE !== "1") return [];
	const aiType = (process.env.AI_TYPE ?? "") as SupportedAiTypes;
	const modelName = process.env.AI_MODEL_NAME ?? "";
	const apiKey = process.env.AI_API_KEY ?? "";
	if (!aiType || !modelName || !apiKey) {
		return [
			{
				id: "llm-judge:skipped",
				passed: true,
				detail:
					"SEND_HANDLE_LLM_JUDGE=1 but AI_TYPE/AI_MODEL_NAME/AI_API_KEY not fully configured; offline eval ran.",
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
	console.error(`\nSend Handle eval failed: ${failures.length} failure(s).`);
	process.exit(1);
}
console.log(`\nSend Handle eval passed: ${results.length} checks.`);
