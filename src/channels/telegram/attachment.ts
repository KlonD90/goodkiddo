import type { AppConfig } from "../../config";
import type { AttachmentBudgetConfig } from "../../capabilities/attachment_budget";
import type { TelegramAgentSession, TelegramUserInput, TelegramAttachmentBudget } from "./types";
import { ATTACHMENT_COMPACTION_NOTICE } from "./types";
import {
	estimateAttachmentTokens,
	decideAttachmentBudget,
} from "../../capabilities/attachment_budget";
import {
	estimateSessionRuntimeTokens,
	compactSessionForOversizedAttachment,
	extractTextFromContent,
} from "../shared";
import { formatTooLargeMessage } from "../../capabilities/registry";

export function buildAttachmentBudgetConfig(
	config: AppConfig,
): AttachmentBudgetConfig {
	return {
		maxContextWindowTokens: config.maxContextWindowTokens,
		reserveSummaryTokens: config.contextReserveSummaryTokens,
		reserveRecentTurnTokens: config.contextReserveRecentTurnTokens,
		reserveNextTurnTokens: config.contextReserveNextTurnTokens,
	};
}

async function maybeSendAttachmentCompactionNotice(
	enabled: boolean,
	session: TelegramAgentSession,
	callerId: string,
): Promise<void> {
	if (!enabled) {
		return;
	}

	await session.statusEmitter?.emit(callerId, ATTACHMENT_COMPACTION_NOTICE);
}

export async function applyTelegramAttachmentBudget(params: {
	session: TelegramAgentSession;
	budget: TelegramAttachmentBudget;
	content: TelegramUserInput;
	currentUserText?: string;
	currentMessages: import("../../memory/summarize").ThreadMessage[];
	alreadyCompacted: boolean;
	mintThreadId: () => string;
	compactOversizedAttachment?: typeof compactSessionForOversizedAttachment;
}): Promise<
	| { ok: true }
	| {
			ok: false;
			userMessage: string;
	  }
> {
	const {
		session,
		budget,
		content,
		currentUserText,
		currentMessages,
		alreadyCompacted,
		mintThreadId,
	} = params;
	const compactOversizedAttachment =
		params.compactOversizedAttachment ?? compactSessionForOversizedAttachment;
	const attachmentTokens = estimateAttachmentTokens({
		content,
		currentUserText: currentUserText ?? extractTextFromContent(content),
	});
	const maxTokens =
		budget.config.maxContextWindowTokens - budget.config.reserveNextTurnTokens;
	let decision = decideAttachmentBudget({
		attachmentTokens,
		currentRuntimeTokens: estimateSessionRuntimeTokens(
			session,
			currentMessages,
		),
		config: budget.config,
	});
	if (decision.kind === "fit") {
		return { ok: true };
	}
	if (decision.kind === "reject") {
		return {
			ok: false,
			userMessage: formatTooLargeMessage(budget.capabilityName, {
				attachmentTokens,
				maxTokens,
			}),
		};
	}
	if (alreadyCompacted) {
		return {
			ok: false,
			userMessage: formatTooLargeMessage(budget.capabilityName, {
				attachmentTokens,
				maxTokens,
			}),
		};
	}

	await maybeSendAttachmentCompactionNotice(
		budget.enableCompactionNotice,
		session,
		budget.callerId,
	);
	const refreshedMessages = await compactOversizedAttachment(
		session,
		currentMessages,
		mintThreadId,
	);
	decision = decideAttachmentBudget({
		attachmentTokens,
		currentRuntimeTokens: estimateSessionRuntimeTokens(
			session,
			refreshedMessages,
		),
		config: budget.config,
	});
	if (decision.kind !== "fit") {
		return {
			ok: false,
			userMessage: formatTooLargeMessage(budget.capabilityName, {
				attachmentTokens,
				maxTokens,
			}),
		};
	}

	return { ok: true };
}
