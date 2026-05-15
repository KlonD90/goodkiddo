import type { ThreadMessage } from "../memory/summarize";

export type SendHandleChannel = "cli" | "telegram" | "telegram_message";

export type SendHandleTrigger = "messy_to_artifact" | "artifact_followup";

export type SendHandleOffReason =
	| "command_or_empty"
	| "multimodal_only"
	| "sensitive_grief_or_harm"
	| "sensitive_conflict_or_escalation"
	| "sensitive_billing_or_refund"
	| "sensitive_security"
	| "sensitive_legal_medical_safety"
	| "no_customer_artifact_signal";

export type SendHandleDecision =
	| {
			eligible: true;
			trigger: SendHandleTrigger;
			channel: SendHandleChannel;
			context: string;
	  }
	| {
			eligible: false;
			offReason: SendHandleOffReason;
			channel: SendHandleChannel;
	  };

export type SendHandleInput = {
	currentUserText?: string;
	recentMessages: ThreadMessage[];
	channel: SendHandleChannel;
};

const SENSITIVE_PATTERNS: Array<{
	reason: Exclude<
		SendHandleOffReason,
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
		reason: "sensitive_legal_medical_safety",
		patterns: [
			/\b(legal|lawyer|lawsuit|sue|suing|compliance|regulator|medical|doctor|diagnosis|unsafe|safety|self[- ]?harm|suicide|kill myself|emergency)\b/i,
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
			/\b(security|hacked|hack|password|breach|breached|phishing|fraud|stolen|account takeover|2fa|mfa|login|suspicious login|privacy|private data|personal data|pii|data protection|gdpr|data retention|data deletion|data access)\b/i,
		],
	},
];

const CUSTOMER_CONTEXT =
	/\b(customer|client|vendor|lead|prospect|buyer|user|support|business|work|telegram|chat|thread|conversation|message|reply|respond|response|email|dm|inbox)\b/i;

const ARTIFACT_REQUEST =
	/\b(draft|write|rewrite|turn (?:this|it) into|make (?:this|it)|compose|reply|respond|response|checklist|list|next step|missing question|question to ask|what to ask|ask before|send|say|answer)\b/i;

const MESSY_UNCERTAIN =
	/\b(messy|blob|uncertain|unsure|not sure|don't know|dont know|confusing|overwhelmed|stuck|awkward|delicate|hard to answer|shape|clean up|untangle|warmer|warm|kind|calm)\b/i;

const FOLLOWUP_HANDLE_REQUEST =
	/\b(push back|pushback|object|objection|shorter|trim|too long|if they|what if|alternative|backup|one[- ]liner|phrase|line|send instead|overpromising|warm(?:er)?|ETA|delivery window)\b/i;

const PURE_COMPLETION =
	/^(?:perfect|great|looks good|thanks|thank you|got it|done|sent it|shipped|that works)[\s.!]*(?:thanks|thank you)?[\s.!]*$/i;

const ASSISTANT_ARTIFACT =
	/\b(draft|reply|response|checklist|next step|missing question|question to ask|send this|you can say)\b/i;

const FORBIDDEN_SELF_PRAISE_PATTERNS = [
	/\b(?:tiny win:\s*)?the (?:mess|thread) is now\b/i,
	/\bthe thread is solved\b/i,
	/\bwe cleaned(?: this| up)?\b/i,
	/\bGoodKiddo (?:solved|turned this into)\b/i,
	/\bI (?:cleaned this up|turned this into)\b/i,
];

export function decideSendHandle(input: SendHandleInput): SendHandleDecision {
	const currentText = input.currentUserText?.trim() ?? "";
	if (currentText === "" || currentText.startsWith("/")) {
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
		context: renderSendHandleContext(trigger),
	};
}

export function getSendHandleContext(
	input: SendHandleInput,
): string | undefined {
	const decision = decideSendHandle(input);
	return decision.eligible ? decision.context : undefined;
}

export function isForbiddenSelfPraise(text: string): boolean {
	return FORBIDDEN_SELF_PRAISE_PATTERNS.some((pattern) => pattern.test(text));
}

function detectSensitiveOffReason(
	currentText: string,
	recentMessages: ThreadMessage[],
): Exclude<
	SendHandleOffReason,
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
): SendHandleTrigger | null {
	if (PURE_COMPLETION.test(currentText)) {
		return null;
	}

	if (
		ARTIFACT_REQUEST.test(currentText) &&
		(MESSY_UNCERTAIN.test(currentText) ||
			CUSTOMER_CONTEXT.test(currentText) ||
			hasRecentCustomerArtifactContext(recentMessages))
	) {
		return "messy_to_artifact";
	}

	if (
		FOLLOWUP_HANDLE_REQUEST.test(currentText) &&
		recentMessages
			.slice(-4)
			.some(
				(message) =>
					message.role === "assistant" &&
					ASSISTANT_ARTIFACT.test(message.content),
			)
	) {
		return "artifact_followup";
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

function renderSendHandleContext(trigger: SendHandleTrigger): string {
	const triggerLabel =
		trigger === "messy_to_artifact"
			? "messy customer-facing thread becoming a usable artifact"
			: "user asking how to use, trim, or defend a recent artifact";
	return [
		"[Good Vibes: Send Handle]",
		`- Candidate trigger: ${triggerLabel}.`,
		"- You MAY end this reply with at most one small practical handhold only if this turn produces a draft, checklist, missing question, or concrete next step.",
		"- The handle must be artifact-adjacent and user-owned: a phrase, check, edit, or choice the user can send, check, trim, or reuse.",
		"- Keep it under 18 words, specific, and optional. The human decides what to send; do not imply auto-sending.",
		"- Good examples: Before sending: confirm the ETA and replace `[delivery window]`.",
		"- Good examples: Start with the answer you need today; save nice-to-have details for later.",
		"- Good examples: Use this if they push back: ‘I can do today or tomorrow — which works better?’",
		"- Good examples: To stay warm without overpromising: keep the first sentence, then add the ETA.",
		"- Good examples: If you want shorter: send only the first two sentences.",
		"- Do not add self-praise, bot celebration, or a trophy line about your output.",
		'- Never write: Tiny win; "the mess/thread is now..."; "we cleaned..."; "the thread is solved"; "GoodKiddo solved...".',
		'- Avoid: "I noticed", "as an AI", forced cheer, corporate tone, emoji spam. Zero or one emoji max.',
		"- Skip the handle if the situation is sensitive, high-stakes, low-signal, or the line would distract.",
		"[/Good Vibes: Send Handle]",
	].join("\n");
}
