import type { CapabilityOutput } from "./types";

export type AttachmentBudgetConfig = {
	maxContextWindowTokens: number;
	reserveSummaryTokens: number;
	reserveRecentTurnTokens: number;
	reserveNextTurnTokens: number;
};

export type AttachmentBudgetDecision =
	| { kind: "fit" }
	| { kind: "compact_then_inject"; attachmentTokens: number }
	| { kind: "reject"; attachmentTokens: number; maxTokens: number };

export function estimateAttachmentTokens(output: CapabilityOutput): number {
	if (typeof output.content === "string") {
		return Math.ceil(output.content.length / 4);
	}

	return output.content.reduce((sum, part) => {
		if (part.type !== "text") return sum;
		return sum + Math.ceil(part.text.length / 4);
	}, 0);
}

export function decideAttachmentBudget(params: {
	attachmentTokens: number;
	currentRuntimeTokens: number;
	config: AttachmentBudgetConfig;
}): AttachmentBudgetDecision {
	const { attachmentTokens, currentRuntimeTokens, config } = params;
	const availableBudget =
		config.maxContextWindowTokens -
		config.reserveSummaryTokens -
		config.reserveRecentTurnTokens -
		config.reserveNextTurnTokens;
	const maxAttachmentTokens =
		config.maxContextWindowTokens - config.reserveNextTurnTokens;

	if (attachmentTokens > maxAttachmentTokens) {
		return {
			kind: "reject",
			attachmentTokens,
			maxTokens: maxAttachmentTokens,
		};
	}

	if (attachmentTokens + currentRuntimeTokens > availableBudget) {
		return {
			kind: "compact_then_inject",
			attachmentTokens,
		};
	}

	return { kind: "fit" };
}
