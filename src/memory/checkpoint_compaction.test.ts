import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
	type CheckpointSummary,
	deserializeCheckpointSummary,
	generateCheckpointSummary,
	serializeCheckpointSummary,
} from "./checkpoint_compaction";
import type { ThreadMessage } from "./summarize";

function createStubModel(response: string | object) {
	const seen: Array<{ role: string; content: string }> = [];
	const model = {
		async invoke(messages: Array<{ role: string; content: string }>) {
			for (const m of messages) seen.push(m);
			const content =
				typeof response === "string" ? response : JSON.stringify(response);
			return { content };
		},
	} as unknown as BaseChatModel;
	return { model, seen };
}

// Returns a different response each invocation so we can test the retry path.
function createSequencedStubModel(responses: Array<string | object>) {
	const seen: Array<{ role: string; content: string }> = [];
	let call = 0;
	const model = {
		async invoke(messages: Array<{ role: string; content: string }>) {
			for (const m of messages) seen.push(m);
			const response = responses[Math.min(call, responses.length - 1)];
			call++;
			const content =
				typeof response === "string" ? response : JSON.stringify(response);
			return { content };
		},
	} as unknown as BaseChatModel;
	return { model, seen, callCount: () => call };
}

const SAMPLE_MESSAGES: ThreadMessage[] = [
	{ role: "user", content: "Build a CSV export feature" },
	{
		role: "assistant",
		content: "I'll implement that. I've created export.ts and added the route.",
	},
	{ role: "user", content: "Also add a download button to the UI" },
	{
		role: "assistant",
		content:
			"Sure, I'll add it. Waiting for your approval on the button placement.",
	},
];

describe("generateCheckpointSummary", () => {
	test("returns empty summary for zero messages", async () => {
		const { model } = createStubModel("unused");
		const summary = await generateCheckpointSummary(model, []);
		expect(summary.current_goal).toBe("");
		expect(summary.decisions).toEqual([]);
		expect(summary.constraints).toEqual([]);
		expect(summary.unfinished_work).toEqual([]);
		expect(summary.pending_approvals).toEqual([]);
		expect(summary.important_artifacts).toEqual([]);
	});

	test("parses structured JSON response and returns all fields", async () => {
		const expectedPayload = {
			current_goal: "Build CSV export with download button",
			decisions: ["Use export.ts for the logic", "Add route /export/csv"],
			constraints: ["Must be backward compatible"],
			unfinished_work: ["Add download button to UI"],
			pending_approvals: ["Button placement in UI"],
			important_artifacts: ["export.ts"],
		};
		const { model, seen } = createStubModel(JSON.stringify(expectedPayload));
		const summary = await generateCheckpointSummary(model, SAMPLE_MESSAGES);

		expect(summary.current_goal).toBe("Build CSV export with download button");
		expect(summary.decisions).toEqual([
			"Use export.ts for the logic",
			"Add route /export/csv",
		]);
		expect(summary.constraints).toEqual(["Must be backward compatible"]);
		expect(summary.unfinished_work).toEqual(["Add download button to UI"]);
		expect(summary.pending_approvals).toEqual(["Button placement in UI"]);
		expect(summary.important_artifacts).toEqual(["export.ts"]);

		expect(seen).toHaveLength(2);
		expect(seen[0]?.role).toBe("system");
		expect(seen[1]?.role).toBe("user");
		expect(seen[1]?.content).toContain("USER: Build a CSV export feature");
	});

	test("strips markdown code fences from model output", async () => {
		const payload = {
			current_goal: "Finish auth",
			decisions: ["Use JWT"],
			constraints: [],
			unfinished_work: ["refresh tokens"],
			pending_approvals: [],
			important_artifacts: ["auth.ts"],
		};
		const { model } = createStubModel(
			`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
		);
		const summary = await generateCheckpointSummary(model, [
			{ role: "user", content: "Build auth" },
		]);
		expect(summary.current_goal).toBe("Finish auth");
		expect(summary.decisions).toEqual(["Use JWT"]);
		expect(summary.unfinished_work).toEqual(["refresh tokens"]);
		expect(summary.important_artifacts).toEqual(["auth.ts"]);
	});

	test("falls back gracefully when model returns invalid JSON on both attempts", async () => {
		const { model, callCount } = createSequencedStubModel([
			"sorry I cannot summarize this",
			"still not JSON",
		]);
		const summary = await generateCheckpointSummary(model, [
			{ role: "user", content: "hello" },
		]);
		expect(summary).toBeDefined();
		expect(Array.isArray(summary.decisions)).toBe(true);
		expect(Array.isArray(summary.unfinished_work)).toBe(true);
		// Raw (first-attempt) text preserved as goal so at least some signal survives.
		expect(summary.current_goal).toBe("sorry I cannot summarize this");
		// Flag lets runtime_context warn the agent that the checkpoint is partial.
		expect(summary.degraded).toBe(true);
		// Retry was attempted (2 invocations total).
		expect(callCount()).toBe(2);
	});

	test("retries once and recovers when model self-corrects on second attempt", async () => {
		const validPayload = {
			current_goal: "Ship the feature",
			decisions: ["Use approach A"],
			constraints: [],
			unfinished_work: [],
			pending_approvals: [],
			important_artifacts: [],
		};
		const { model, callCount } = createSequencedStubModel([
			"not JSON at all",
			JSON.stringify(validPayload),
		]);
		const summary = await generateCheckpointSummary(model, [
			{ role: "user", content: "hello" },
		]);
		expect(summary.current_goal).toBe("Ship the feature");
		expect(summary.decisions).toEqual(["Use approach A"]);
		expect(summary.degraded).toBeUndefined();
		expect(callCount()).toBe(2);
	});

	test("does not retry when first attempt parses successfully", async () => {
		const payload = {
			current_goal: "Goal",
			decisions: [],
			constraints: [],
			unfinished_work: [],
			pending_approvals: [],
			important_artifacts: [],
		};
		const { model, callCount } = createSequencedStubModel([
			JSON.stringify(payload),
			"never returned",
		]);
		const summary = await generateCheckpointSummary(model, [
			{ role: "user", content: "hello" },
		]);
		expect(summary.current_goal).toBe("Goal");
		expect(callCount()).toBe(1);
	});

	test("returns degraded summary when retry invocation itself throws", async () => {
		let call = 0;
		const model = {
			async invoke(_messages: Array<{ role: string; content: string }>) {
				call++;
				if (call === 1) return { content: "not JSON" };
				throw new Error("model network error");
			},
		} as unknown as BaseChatModel;

		const summary = await generateCheckpointSummary(model, [
			{ role: "user", content: "hello" },
		]);
		expect(summary.current_goal).toBe("not JSON");
		expect(summary.degraded).toBe(true);
		expect(call).toBe(2);
	});

	test("preserves key operational state across compaction boundary", async () => {
		const goal = "Deploy payment integration";
		const payload: CheckpointSummary = {
			current_goal: goal,
			decisions: ["Use Stripe SDK v4", "Retry on 5xx"],
			constraints: ["PCI-DSS scope must not expand"],
			unfinished_work: ["webhook handler", "3DS2 flow"],
			pending_approvals: ["prod secret rotation"],
			important_artifacts: ["src/payments/stripe.ts", "STRIPE_KEY"],
		};
		const { model } = createStubModel(payload);
		const messages: ThreadMessage[] = [
			{ role: "user", content: "Integrate Stripe for payments" },
			{
				role: "assistant",
				content:
					"Done. Webhook and 3DS still needed. Waiting for prod secret approval.",
			},
		];
		const summary = await generateCheckpointSummary(model, messages);

		expect(summary.current_goal).toBe(goal);
		expect(summary.decisions).toContain("Use Stripe SDK v4");
		expect(summary.constraints).toContain("PCI-DSS scope must not expand");
		expect(summary.unfinished_work).toContain("webhook handler");
		expect(summary.pending_approvals).toContain("prod secret rotation");
		expect(summary.important_artifacts).toContain("src/payments/stripe.ts");
	});

	test("handles array content shape from LLM response", async () => {
		const payload: CheckpointSummary = {
			current_goal: "Fix the login bug",
			decisions: ["Patch session cookie"],
			constraints: [],
			unfinished_work: [],
			pending_approvals: [],
			important_artifacts: ["auth/session.ts"],
		};
		const seen: Array<{ role: string; content: unknown }> = [];
		const model = {
			async invoke(messages: Array<{ role: string; content: unknown }>) {
				for (const m of messages) seen.push(m);
				return {
					content: [{ type: "text", text: JSON.stringify(payload) }],
				};
			},
		} as unknown as BaseChatModel;

		const summary = await generateCheckpointSummary(model, [
			{ role: "user", content: "Fix login" },
		]);
		expect(summary.current_goal).toBe("Fix the login bug");
		expect(summary.decisions).toEqual(["Patch session cookie"]);
	});
});

describe("serializeCheckpointSummary / deserializeCheckpointSummary", () => {
	test("round-trips a full summary through JSON serialization", () => {
		const summary: CheckpointSummary = {
			current_goal: "Build feature X",
			decisions: ["Use approach A"],
			constraints: ["No external deps"],
			unfinished_work: ["Tests"],
			pending_approvals: ["Security review"],
			important_artifacts: ["feature-x.ts"],
		};
		const payload = serializeCheckpointSummary(summary);
		expect(typeof payload).toBe("string");
		const restored = deserializeCheckpointSummary(payload);
		expect(restored).toEqual(summary);
	});

	test("deserialize returns empty defaults for corrupted payload", () => {
		const result = deserializeCheckpointSummary("not json at all {{{{");
		expect(result.current_goal).toBe("");
		expect(result.decisions).toEqual([]);
		expect(result.unfinished_work).toEqual([]);
		expect(result.constraints).toEqual([]);
		expect(result.pending_approvals).toEqual([]);
		expect(result.important_artifacts).toEqual([]);
	});

	test("deserialize fills missing keys with defaults for partial payload", () => {
		const partial = JSON.stringify({
			current_goal: "Deploy",
			decisions: ["Use Docker"],
		});
		const result = deserializeCheckpointSummary(partial);
		expect(result.current_goal).toBe("Deploy");
		expect(result.decisions).toEqual(["Use Docker"]);
		expect(result.constraints).toEqual([]);
		expect(result.unfinished_work).toEqual([]);
		expect(result.pending_approvals).toEqual([]);
		expect(result.important_artifacts).toEqual([]);
	});

	test("round-trips the degraded flag when set", () => {
		const summary: CheckpointSummary = {
			current_goal: "raw fallback text",
			decisions: [],
			constraints: [],
			unfinished_work: [],
			pending_approvals: [],
			important_artifacts: [],
			degraded: true,
		};
		const restored = deserializeCheckpointSummary(
			serializeCheckpointSummary(summary),
		);
		expect(restored.degraded).toBe(true);
		expect(restored.current_goal).toBe("raw fallback text");
	});

	test("filters non-string entries from array fields", () => {
		const messy = JSON.stringify({
			current_goal: "Goal",
			decisions: ["valid", 42, null, "also valid"],
			constraints: [],
			unfinished_work: [],
			pending_approvals: [],
			important_artifacts: [],
		});
		const result = deserializeCheckpointSummary(messy);
		expect(result.decisions).toEqual(["valid", "also valid"]);
	});
});
