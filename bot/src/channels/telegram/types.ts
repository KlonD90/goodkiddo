import type { Bot } from "grammy";
import type { AttachmentBudgetConfig } from "../../capabilities/attachment_budget";
import type { CapabilityRegistry } from "../../capabilities/registry";
import type { TimerStore } from "../../capabilities/timers/store";
import type { FileMetadata } from "../../capabilities/types";
import type { AppConfig } from "../../config";
import type { ApprovalBroker, ApprovalOutcome, ApprovalRequest } from "../../permissions/approval";
import type { PermissionsStore } from "../../permissions/store";
import type { Caller } from "../../permissions/types";
import type { ChannelAgentSession } from "../shared";
import type { OutboundChannel, OutboundSendFileArgs, OutboundSendResult } from "../outbound";
import type { AppChannel, ChannelRunOptions } from "../types";
import type { createDb } from "../../db";

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
export const APPROVAL_TIMEOUT_MS = 120_000;
export const TELEGRAM_HTML_PARSE_MODE = "HTML";
export const TELEGRAM_TYPING_INTERVAL_MS = 4_000;
export const TELEGRAM_STREAM_PARAGRAPH_FLUSH_INTERVAL_MS = 2_500;
export const TELEGRAM_STREAM_CHUNK_MIN_LENGTH = 240;
export const TELEGRAM_STREAM_CHUNK_TARGET_LENGTH = 900;
export const TELEGRAM_STREAM_CHUNK_HARD_LENGTH = 1_600;
export const ATTACHMENT_COMPACTION_NOTICE =
	"Summarizing older messages to make room for this attachment...";
export const TELEGRAM_STREAM_DEFAULT_BOUNDARY_PATTERNS = [
	/\n\n/g,
	/\n/g,
	/[.!?](?:\s|$)/g,
	/[;:](?:\s|$)/g,
	/, /g,
	/ /g,
] as const;
export const TELEGRAM_STREAM_PARAGRAPH_BOUNDARY_PATTERNS = [/\n\s*\n/g] as const;
export const TELEGRAM_STREAM_OVERFLOW_BOUNDARY_PATTERNS = [
	/\n\s*\n/g,
	/\n/g,
	/\s+/g,
] as const;
export const TELEGRAM_COMMANDS = [
	{ command: "start", description: "Show how to start using the assistant" },
	{ command: "help", description: "Show available permission commands" },
	{ command: "new_thread", description: "Start a fresh conversation thread" },
	{ command: "open_fs", description: "Open your files in a web browser" },
	{ command: "revoke_fs", description: "Revoke all active file-share links" },
	{ command: "fetch", description: "Morning Fetch is reserved for later" },
] as const;

export type PendingApproval = {
	request: ApprovalRequest;
	resolve: (outcome: ApprovalOutcome) => Promise<void>;
	timeout: NodeJS.Timeout;
	promptId: string;
};

export type TelegramAgentSession = ChannelAgentSession & {
	running: boolean;
	queue: TelegramQueuedTurn[];
	pendingApprovals: Map<string, PendingApproval>;
};

export type TelegramTextContentBlock = {
	type: "text";
	text: string;
};

export type TelegramImageContentBlock = {
	type: "image";
	mimeType: string;
	data: Uint8Array;
};

export type TelegramUserInput =
	| string
	| Array<TelegramTextContentBlock | TelegramImageContentBlock>;

export type TelegramQueuedTurn = {
	content: TelegramUserInput;
	commandText: string;
	currentUserText?: string;
	currentMessageDate?: Date;
	attachmentBudget?: TelegramAttachmentBudget;
};

export type TelegramAttachmentBudget = {
	capabilityName: string;
	config: AttachmentBudgetConfig;
	enableCompactionNotice: boolean;
	callerId: string;
};

export type ProcessTelegramFileHelpers = {
	sendMessage?: (bot: Bot, chatId: string, text: string, options?: Record<string, unknown>) => Promise<void>;
	queueTurn?: (
		session: TelegramAgentSession,
		bot: Bot,
		chatId: string,
		commandText: string,
		content: TelegramUserInput,
		caller: Caller,
		store: PermissionsStore,
		webShare: ChannelRunOptions["webShare"],
		currentUserText?: string,
		attachmentBudget?: TelegramAttachmentBudget,
		currentMessageDate?: Date,
	) => Promise<void>;
};

export type TelegramListState = { type: "bullet" } | { type: "ordered"; next: number };

export type TelegramMarkdownRenderEnv = {
	telegramLists?: TelegramListState[];
};

export type MarkdownTableBlock = {
	start: number;
	end: number;
	header: string;
	separator: string;
	rows: string[];
};

export type TrailingMarkdownTableContext = {
	start: number;
	header: string;
	separator: string;
	rows: string[];
};

export type TelegramMarkdownChunkContext = {
	openDelimiters: string[];
	inCodeFence: boolean;
	inInlineCode: boolean;
	trailingTable: TrailingMarkdownTableContext | null;
};

export function dateFromTelegramMessage(
	messageDate: number | undefined,
): Date | undefined {
	if (messageDate === undefined) return undefined;
	return new Date(messageDate * 1000);
}

export type TelegramChatLike = {
	type?: string;
};

export function isTelegramPrivateChat(
	chat: TelegramChatLike | null | undefined,
): boolean {
	return chat?.type === "private";
}

export function isTelegramGroupChat(
	chat: TelegramChatLike | null | undefined,
): boolean {
	return chat?.type === "group" || chat?.type === "supergroup";
}

export function normalizeTelegramCommandText(text: string | null | undefined): string {
	return typeof text === "string" ? text.trim() : "";
}
