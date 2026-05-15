import type { ThreadMessage } from "../memory/summarize";

export type SendHandleFixture = {
	id: string;
	description: string;
	channel: "cli" | "telegram";
	currentUserText: string;
	recentMessages: ThreadMessage[];
	expectCandidate: boolean;
	expectedTrigger?: "messy_to_artifact" | "artifact_followup";
	expectedOffReason?: string;
	expectedHandleExamples?: string[];
};

export const forbiddenSelfPraisePhrases = [
	"Tiny win: the mess is now one reply",
	"Tiny win: the thread is now one reply",
	"the mess is now one reply",
	"the thread is solved",
	"we cleaned this up",
	"we cleaned up the thread",
	"GoodKiddo solved",
	"GoodKiddo turned this into",
	"I cleaned this up",
	"I turned this into",
];

export const sendHandleFixtures: SendHandleFixture[] = [
	{
		id: "draft-messy-customer-reply",
		description: "messy customer thread asks for a concrete reply draft",
		channel: "telegram",
		currentUserText:
			"Customer says the delivery is late and I don't know how to answer without sounding defensive. Can you turn this into a kind reply and one question?",
		recentMessages: [],
		expectCandidate: true,
		expectedTrigger: "messy_to_artifact",
		expectedHandleExamples: [
			"Before sending: confirm the ETA and replace `[delivery window]`.",
			"If you want shorter: send only the first two sentences.",
		],
	},
	{
		id: "checklist-missing-context",
		description: "uncertain business chat asks for missing questions/checklist",
		channel: "cli",
		currentUserText:
			"This client chat is a blob. Help me make a quick checklist of what to ask before I reply.",
		recentMessages: [],
		expectCandidate: true,
		expectedTrigger: "messy_to_artifact",
		expectedHandleExamples: [
			"Start with the answer you need today; save nice-to-have details for later.",
		],
	},
	{
		id: "recent-context-generic-reply",
		description:
			"recent customer context lets a short generic reply request qualify",
		channel: "telegram",
		currentUserText: "Can you draft a warmer answer?",
		recentMessages: [
			{
				role: "user",
				content:
					"A lead asked whether we can deliver by Friday. I am unsure how much detail to include in the response.",
			},
		],
		expectCandidate: true,
		expectedTrigger: "messy_to_artifact",
		expectedHandleExamples: [
			"To stay warm without overpromising: keep the first sentence, then add the ETA.",
		],
	},
	{
		id: "after-draft-user-asks-pushback-line",
		description:
			"after an artifact, a user asks for one practical follow-up phrase",
		channel: "telegram",
		currentUserText: "Looks good. What if they push back?",
		recentMessages: [
			{
				role: "user",
				content: "Can you draft a calm reply to the vendor?",
			},
			{
				role: "assistant",
				content:
					"Draft reply:\n\nHi Sam — thanks for the update. Could you confirm the revised delivery date and whether anything else is blocked on your side?",
			},
		],
		expectCandidate: true,
		expectedTrigger: "artifact_followup",
		expectedHandleExamples: [
			"Use this if they push back: ‘I can do today or tomorrow — which works better?’",
		],
	},
	{
		id: "finish-after-draft-off",
		description:
			"pure completion thanks does not invite a bot-owned victory lap",
		channel: "telegram",
		currentUserText: "Perfect, sent it. Thanks.",
		recentMessages: [
			{
				role: "user",
				content: "Can you draft a calm reply to the vendor?",
			},
			{
				role: "assistant",
				content:
					"Draft reply:\n\nHi Sam — thanks for the update. Could you confirm the revised delivery date?",
			},
		],
		expectCandidate: false,
		expectedOffReason: "no_customer_artifact_signal",
	},
	{
		id: "grief-off",
		description: "grief/support flow must stay off",
		channel: "telegram",
		currentUserText:
			"My customer's father died and I need a reply draft that doesn't sound cold.",
		recentMessages: [],
		expectCandidate: false,
		expectedOffReason: "sensitive_grief_or_harm",
	},
	{
		id: "anger-complaint-off",
		description: "angry complaint flow must stay off",
		channel: "telegram",
		currentUserText:
			"This customer is furious and yelling about our service. Draft a response to the complaint.",
		recentMessages: [],
		expectCandidate: false,
		expectedOffReason: "sensitive_conflict_or_escalation",
	},
	{
		id: "billing-refund-off",
		description: "refund/billing flow must stay off",
		channel: "cli",
		currentUserText:
			"Please help draft a reply about their refund and disputed invoice payment.",
		recentMessages: [],
		expectCandidate: false,
		expectedOffReason: "sensitive_billing_or_refund",
	},
	{
		id: "recent-billing-refund-generic-draft-off",
		description:
			"billing/refund in recent history keeps a generic draft request off",
		channel: "telegram",
		currentUserText: "Can you draft the customer response?",
		recentMessages: [
			{
				role: "user",
				content:
					"They are asking for a refund on a disputed invoice and I need to answer carefully.",
			},
		],
		expectCandidate: false,
		expectedOffReason: "sensitive_billing_or_refund",
	},
	{
		id: "security-off",
		description: "security incident flow must stay off",
		channel: "telegram",
		currentUserText:
			"A customer says their account was hacked and password changed. Draft the support response.",
		recentMessages: [],
		expectCandidate: false,
		expectedOffReason: "sensitive_security",
	},
	{
		id: "privacy-personal-data-off",
		description: "privacy and personal data flow must stay off",
		channel: "telegram",
		currentUserText:
			"A client is worried about privacy and personal data handling. Draft a calm response.",
		recentMessages: [],
		expectCandidate: false,
		expectedOffReason: "sensitive_security",
	},
	{
		id: "recent-privacy-generic-draft-off",
		description: "privacy in recent history keeps a generic draft request off",
		channel: "telegram",
		currentUserText: "Can you draft a calm response?",
		recentMessages: [
			{
				role: "user",
				content:
					"The client is worried about how we handle PII and data retention for private data.",
			},
		],
		expectCandidate: false,
		expectedOffReason: "sensitive_security",
	},
	{
		id: "recent-security-generic-reply-off",
		description: "security in recent history keeps a generic reply request off",
		channel: "telegram",
		currentUserText: "Can you help me reply to the customer?",
		recentMessages: [
			{
				role: "user",
				content:
					"The customer says their account had a suspicious login and possible password breach.",
			},
		],
		expectCandidate: false,
		expectedOffReason: "sensitive_security",
	},
	{
		id: "escalation-off",
		description: "urgent human escalation flow must stay off",
		channel: "telegram",
		currentUserText:
			"This is an urgent outage; help me escalate to a manager and tell them a human will respond.",
		recentMessages: [],
		expectCandidate: false,
		expectedOffReason: "sensitive_conflict_or_escalation",
	},
	{
		id: "recent-anger-artifact-followup-off",
		description:
			"anger/escalation in recent artifact context keeps follow-up handle off",
		channel: "telegram",
		currentUserText: "What if they push back?",
		recentMessages: [
			{
				role: "user",
				content:
					"Customer is furious and wants this escalated to a manager. Draft the response.",
			},
			{
				role: "assistant",
				content:
					"Draft response:\n\nI understand this is frustrating. I am escalating this to a manager now and will follow up with the next update.",
			},
		],
		expectCandidate: false,
		expectedOffReason: "sensitive_conflict_or_escalation",
	},
	{
		id: "recent-grief-high-stakes-followup-off",
		description:
			"grief/high-stakes in recent history keeps follow-up handle off",
		channel: "telegram",
		currentUserText: "Can you make it shorter?",
		recentMessages: [
			{
				role: "user",
				content:
					"Their partner died and the client is asking how to handle urgent safety logistics. Can you draft a response?",
			},
			{
				role: "assistant",
				content:
					"Draft response:\n\nI am so sorry for your loss. Please prioritize immediate safety needs and contact local emergency support if there is danger.",
			},
		],
		expectCandidate: false,
		expectedOffReason: "sensitive_grief_or_harm",
	},
	{
		id: "legal-medical-off",
		description: "legal/medical/safety request must stay off",
		channel: "telegram",
		currentUserText:
			"A client asked for medical advice after an unsafe incident. Draft what to say.",
		recentMessages: [],
		expectCandidate: false,
		expectedOffReason: "sensitive_legal_medical_safety",
	},
	{
		id: "low-signal-off",
		description: "low-signal thanks/chat must stay off",
		channel: "telegram",
		currentUserText: "lol nice",
		recentMessages: [],
		expectCandidate: false,
		expectedOffReason: "no_customer_artifact_signal",
	},
	{
		id: "command-off",
		description: "commands are not candidates",
		channel: "telegram",
		currentUserText: "/new_thread",
		recentMessages: [],
		expectCandidate: false,
		expectedOffReason: "command_or_empty",
	},
];
