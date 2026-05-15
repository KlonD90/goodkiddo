import type { ThreadMessage } from "../memory/summarize";

export type ThreadRibbonFixture = {
	id: string;
	description: string;
	channel: "cli" | "telegram";
	currentUserText: string;
	recentMessages: ThreadMessage[];
	expectCandidate: boolean;
	expectedTrigger?: "messy_to_artifact" | "finish_after_artifact";
	expectedOffReason?: string;
};

export const threadRibbonFixtures: ThreadRibbonFixture[] = [
	{
		id: "draft-messy-customer-reply",
		description: "messy customer thread asks for a concrete reply draft",
		channel: "telegram",
		currentUserText:
			"Customer says the delivery is late and I don't know how to answer without sounding defensive. Can you turn this into a kind reply and one question?",
		recentMessages: [],
		expectCandidate: true,
		expectedTrigger: "messy_to_artifact",
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
	},
	{
		id: "finish-after-draft",
		description: "user confirms completion after assistant produced a draft",
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
					"Draft reply:\n\nHi Sam — thanks for the update. Could you confirm the revised delivery date and whether anything else is blocked on your side?",
			},
		],
		expectCandidate: true,
		expectedTrigger: "finish_after_artifact",
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
		id: "recent-anger-artifact-finish-off",
		description:
			"anger/escalation in recent artifact context keeps finish confirmation off",
		channel: "telegram",
		currentUserText: "Sent it thanks.",
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
		id: "recent-grief-high-stakes-finish-off",
		description:
			"grief/high-stakes in recent history keeps finish confirmation off",
		channel: "telegram",
		currentUserText: "Done, thank you.",
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
		id: "command-off",
		description: "commands are not candidates",
		channel: "telegram",
		currentUserText: "/new_thread",
		recentMessages: [],
		expectCandidate: false,
		expectedOffReason: "command_or_empty",
	},
];
