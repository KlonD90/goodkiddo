import type { ThreadMessage } from "../memory/summarize";

export type ThreadRibbonChannel = "cli" | "telegram" | "telegram_message";

export type ThreadRibbonTrigger = "messy_to_artifact" | "finish_after_artifact";

export type ThreadRibbonOffReason =
	| "command_or_empty"
	| "multimodal_only"
	| "sensitive_grief_or_harm"
	| "sensitive_conflict_or_escalation"
	| "sensitive_billing_or_refund"
	| "sensitive_security"
	| "sensitive_legal_medical_safety"
	| "no_customer_artifact_signal";

export type ThreadRibbonDecision =
	| {
			eligible: true;
			trigger: ThreadRibbonTrigger;
			channel: ThreadRibbonChannel;
			context: string;
	  }
	| {
			eligible: false;
			offReason: ThreadRibbonOffReason;
			channel: ThreadRibbonChannel;
	  };

export type ThreadRibbonInput = {
	currentUserText?: string;
	recentMessages: ThreadMessage[];
	channel: ThreadRibbonChannel;
};

const SENSITIVE_PATTERNS: Array<{
	reason: Exclude<
		ThreadRibbonOffReason,
		"command_or_empty" | "multimodal_only" | "no_customer_artifact_signal"
	>;
	patterns: RegExp[];
}> = [
	{
		reason: "sensitive_grief_or_harm",
		patterns: [
			/\b(grief|grieving|bereave|bereavement|died|death|dead|funeral|condolence|illness|cancer|hospital|accident|injur(?:y|ed))\b/i,
		],
	},
	{
		reason: "sensitive_conflict_or_escalation",
		patterns: [
			/\b(angry|furious|rage|yelling|abuse|abusive|harass(?:ed|ment)?|complain(?:t|ing)?|escalat(?:e|ion)|manager|human|urgent outage|outage|incident)\b/i,
		],
	},
	{
		reason: "sensitive_billing_or_refund",
		patterns: [
			/\b(refund|billing|bill|invoice|payment|chargeback|dispute|disputed|cancel(?:lation)?|subscription|overcharg(?:e|ed))\b/i,
		],
	},
	{
		reason: "sensitive_security",
		patterns: [
			/\b(security|hacked|hack|password|breach|breached|phishing|fraud|stolen|account takeover|2fa|mfa|login)\b/i,
		],
	},
	{
		reason: "sensitive_legal_medical_safety",
		patterns: [
			/\b(legal|lawyer|lawsuit|sue|suing|compliance|regulator|medical|doctor|diagnosis|unsafe|safety|self[- ]?harm|suicide|kill myself|emergency)\b/i,
		],
	},
];

const CUSTOMER_CONTEXT =
	/\b(customer|client|vendor|lead|prospect|buyer|user|support|business|work|telegram|chat|thread|conversation|message|reply|respond|response|email|dm|inbox)\b/i;

const ARTIFACT_REQUEST =
	/\b(draft|write|rewrite|turn (?:this|it) into|make (?:this|it)|compose|reply|respond|response|checklist|list|next step|missing question|question to ask|what to ask|ask before|send|say)\b/i;

const MESSY_UNCERTAIN =
	/\b(messy|blob|uncertain|unsure|not sure|don't know|dont know|confusing|overwhelmed|stuck|awkward|delicate|hard to answer|how to answer|shape|clean up|untangle)\b/i;

const FINISH_CONFIRMATION =
	/\b(sent|send it|shipped|done|finished|perfect|great|that works|looks good|thanks|thank you|got it)\b/i;

const ASSISTANT_ARTIFACT =
	/\b(draft|reply|response|checklist|next step|missing question|question to ask|send this|you can say)\b/i;

export function decideThreadRibbon(
	input: ThreadRibbonInput,
): ThreadRibbonDecision {
	const currentText = input.currentUserText?.trim() ?? "";
	if (currentText === "") {
		return {
			eligible: false,
			offReason: "command_or_empty",
			channel: input.channel,
		};
	}
	if (currentText.startsWith("/")) {
		return {
			eligible: false,
			offReason: "command_or_empty",
			channel: input.channel,
		};
	}

	const sensitiveOffReason = detectSensitiveOffReason(
		currentText,
		input.recentMessages,
	);
	if (sensitiveOffReason !== null) {
		return {
			eligible: false,
			offReason: sensitiveOffReason,
			channel: input.channel,
		};
	}

	const trigger = detectTrigger(currentText, input.recentMessages);
	if (trigger === null) {
		return {
			eligible: false,
			offReason: "no_customer_artifact_signal",
			channel: input.channel,
		};
	}

	return {
		eligible: true,
		trigger,
		channel: input.channel,
		context: renderThreadRibbonContext(trigger),
	};
}

export function getThreadRibbonContext(
	input: ThreadRibbonInput,
): string | undefined {
	const decision = decideThreadRibbon(input);
	return decision.eligible ? decision.context : undefined;
}

function detectSensitiveOffReason(
	currentText: string,
	recentMessages: ThreadMessage[],
): Exclude<
	ThreadRibbonOffReason,
	"command_or_empty" | "multimodal_only" | "no_customer_artifact_signal"
> | null {
	const recentContext = recentMessages
		.slice(-6)
		.filter(
			(message) => message.role === "user" || message.role === "assistant",
		)
		.map((message) => message.content)
		.join("\n");
	const textToScan = [currentText, recentContext].filter(Boolean).join("\n");

	for (const sensitive of SENSITIVE_PATTERNS) {
		if (sensitive.patterns.some((pattern) => pattern.test(textToScan))) {
			return sensitive.reason;
		}
	}
	return null;
}

function detectTrigger(
	currentText: string,
	recentMessages: ThreadMessage[],
): ThreadRibbonTrigger | null {
	if (
		CUSTOMER_CONTEXT.test(currentText) &&
		ARTIFACT_REQUEST.test(currentText) &&
		(MESSY_UNCERTAIN.test(currentText) ||
			hasRecentCustomerArtifactContext(recentMessages))
	) {
		return "messy_to_artifact";
	}

	if (
		FINISH_CONFIRMATION.test(currentText) &&
		recentMessages
			.slice(-4)
			.some(
				(message) =>
					message.role === "assistant" &&
					ASSISTANT_ARTIFACT.test(message.content),
			)
	) {
		return "finish_after_artifact";
	}

	return null;
}

function hasRecentCustomerArtifactContext(messages: ThreadMessage[]): boolean {
	const recentText = messages
		.slice(-6)
		.map((message) => message.content)
		.join("\n");
	return CUSTOMER_CONTEXT.test(recentText) && ARTIFACT_REQUEST.test(recentText);
}

function renderThreadRibbonContext(trigger: ThreadRibbonTrigger): string {
	const triggerLabel =
		trigger === "messy_to_artifact"
			? "messy customer-facing thread becoming an artifact"
			: "user confirming a useful artifact/next move is complete";
	return [
		"[Good Vibes: Thread Ribbon]",
		`- Candidate trigger: ${triggerLabel}.`,
		"- You MAY end this reply with one tiny Thread Ribbon only if this turn actually produces a useful draft, checklist, missing question, or concrete next step.",
		"- The ribbon is a bespoke relief/progress line: under 18 words; specific to the artifact/next move; not generic praise.",
		"- Keep human judgment centered: drafts are theirs to send; you are not auto-sending or surveilling.",
		'- Avoid: "I noticed", "as an AI", forced cheer, corporate tone, emoji spam. Zero or one emoji max.',
		"- Skip the ribbon if the situation is sensitive, high-stakes, or the line would distract.",
		"[/Good Vibes: Thread Ribbon]",
	].join("\n");
}
