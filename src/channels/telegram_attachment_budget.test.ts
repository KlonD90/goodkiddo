import { describe, expect, test } from "bun:test";
import type { Bot } from "grammy";
import { CapabilityRegistry } from "../capabilities/registry";
import type { FileCapability } from "../capabilities/types";
import type { AppConfig } from "../config";
import type { ThreadMessage } from "../memory/summarize";
import type { PermissionsStore } from "../permissions/store";
import type { StatusEmitter } from "../tools/status_emitter";
import { applyTelegramAttachmentBudget, processTelegramFile } from "./telegram";

const ATTACHMENT_TEST_CONFIG: AppConfig = {
	aiApiKey: "test-key",
	aiBaseUrl: "",
	aiType: "openai",
	aiModelName: "gpt-4o-mini",
	appEntrypoint: "telegram",
	telegramBotToken: "telegram-token",
	telegramAllowedChatId: "",
	usingMode: "single",
	blockedUserMessage: "blocked",
	maxContextWindowTokens: 20,
	contextReserveSummaryTokens: 2,
	contextReserveRecentTurnTokens: 2,
	contextReserveNextTurnTokens: 2,
	permissionsMode: "disabled",
	databaseUrl: "sqlite://:memory:",
	enableExecute: false,
	enableVoiceMessages: true,
	enablePdfDocuments: true,
	enableSpreadsheets: true,
	enableImageUnderstanding: false,
	enableToolStatus: true,
	enableAttachmentCompactionNotice: true,
	defaultStatusLocale: "en",
	transcriptionProvider: "openai",
	transcriptionApiKey: "test-key",
	transcriptionBaseUrl: "",
	minimaxApiKey: "",
	minimaxApiHost: "https://api.minimax.io",
	webHost: "127.0.0.1",
	webPort: 8083,
	webPublicBaseUrl: "http://localhost:8083",
	timezone: "UTC",
};

type TelegramProcessSession = Parameters<typeof processTelegramFile>[2];

class FakeStatusEmitter implements StatusEmitter {
	calls: Array<{ callerId: string; message: string }> = [];

	async emit(callerId: string, message: string): Promise<void> {
		this.calls.push({ callerId, message });
	}
}

function createAttachmentRegistry(
	name: string,
	content: string,
	currentUserText = content,
): CapabilityRegistry {
	const capability: FileCapability = {
		name,
		canHandle: () => true,
		async process() {
			return {
				ok: true,
				value: {
					content,
					currentUserText,
				},
			};
		},
	};

	return new CapabilityRegistry([capability]);
}

function createProcessSession(
	statusEmitter?: StatusEmitter,
): TelegramProcessSession {
	return {
		agent: {} as never,
		running: false,
		queue: [],
		threadId: "telegram-123",
		workspace: {} as never,
		model: {} as never,
		refreshAgent: async () => {},
		pendingApprovals: new Map(),
		statusEmitter,
		compactionConfig: {
			caller: "telegram:123",
			store: {} as never,
		},
	};
}

function createBudget(
	overrides: Partial<{
		capabilityName: string;
		enableCompactionNotice: boolean;
		callerId: string;
	}> = {},
) {
	return {
		capabilityName: overrides.capabilityName ?? "pdf",
		config: {
			maxContextWindowTokens: ATTACHMENT_TEST_CONFIG.maxContextWindowTokens,
			reserveSummaryTokens: ATTACHMENT_TEST_CONFIG.contextReserveSummaryTokens,
			reserveRecentTurnTokens:
				ATTACHMENT_TEST_CONFIG.contextReserveRecentTurnTokens,
			reserveNextTurnTokens:
				ATTACHMENT_TEST_CONFIG.contextReserveNextTurnTokens,
		},
		enableCompactionNotice: overrides.enableCompactionNotice ?? true,
		callerId: overrides.callerId ?? "telegram:123",
	};
}

describe("processTelegramFile", () => {
	const caller = {
		id: "telegram:123",
		entrypoint: "telegram" as const,
		externalId: "123",
	};

	test("queues attachment budget metadata for supported files", async () => {
		const queued: Array<{
			attachmentBudget?: ReturnType<typeof createBudget>;
		}> = [];

		await processTelegramFile(
			ATTACHMENT_TEST_CONFIG,
			createAttachmentRegistry("pdf", "hello"),
			createProcessSession(),
			{} as Bot,
			"123",
			caller,
			{} as PermissionsStore,
			undefined,
			{
				metadata: { mimeType: "application/pdf", filename: "report.pdf" },
				download: async () => Uint8Array.from([1, 2, 3]),
			},
			{
				queueTurn: async (
					_session,
					_bot,
					_chatId,
					_commandText,
					_content,
					_caller,
					_store,
					_webShare,
					_currentUserText,
					attachmentBudget,
				) => {
					queued.push({ attachmentBudget });
				},
			},
		);

		expect(queued).toEqual([
			{
				attachmentBudget: createBudget(),
			},
		]);
	});
});

describe("applyTelegramAttachmentBudget", () => {
	const meaningfulContext = "meaningful attachment context ".repeat(900);

	test("rejects attachments that cannot fit even in an empty turn", async () => {
		const session = createProcessSession();
		const compacted: string[] = [];

		const result = await applyTelegramAttachmentBudget({
			session,
			budget: createBudget(),
			content: "x".repeat(76),
			currentMessages: [],
			alreadyCompacted: false,
			mintThreadId: () => "telegram-123-next",
			compactOversizedAttachment: async () => {
				compacted.push("called");
				return [];
			},
		});

		expect(result).toEqual({
			ok: false,
			userMessage:
				"This PDF is too large for a single turn (≈19 tokens, max 18). Please send a smaller file or split it.",
		});
		expect(compacted).toEqual([]);
	});

	test("compacts mid-range attachments and emits the notice by default", async () => {
		const emitter = new FakeStatusEmitter();
		const session = createProcessSession(emitter);
		const compacted: string[] = [];
		const currentMessages: ThreadMessage[] = [
			{
				role: "user",
				content: meaningfulContext,
				estimatedTokens: 3,
			},
		];

		const result = await applyTelegramAttachmentBudget({
			session,
			budget: createBudget(),
			content: "x".repeat(48),
			currentMessages,
			alreadyCompacted: false,
			mintThreadId: () => "telegram-123-next",
			compactOversizedAttachment: async () => {
				compacted.push("called");
				return [];
			},
		});

		expect(result).toEqual({ ok: true });
		expect(emitter.calls).toEqual([
			{
				callerId: "telegram:123",
				message:
					"Summarizing older messages to make room for this attachment...",
			},
		]);
		expect(compacted).toEqual(["called"]);
	});

	test("does not emit the notice when the flag is disabled", async () => {
		const emitter = new FakeStatusEmitter();
		const session = createProcessSession(emitter);

		const result = await applyTelegramAttachmentBudget({
			session,
			budget: createBudget({ enableCompactionNotice: false }),
			content: "x".repeat(48),
			currentMessages: [
				{
					role: "user",
					content: meaningfulContext,
					estimatedTokens: 3,
				},
			],
			alreadyCompacted: false,
			mintThreadId: () => "telegram-123-next",
			compactOversizedAttachment: async () => [],
		});

		expect(result).toEqual({ ok: true });
		expect(emitter.calls).toEqual([]);
	});

	test("does not emit the compaction notice for trivial prior context", async () => {
		const emitter = new FakeStatusEmitter();
		const session = createProcessSession(emitter);
		const compacted: string[] = [];

		const result = await applyTelegramAttachmentBudget({
			session,
			budget: createBudget(),
			content: "x".repeat(48),
			currentMessages: [
				{
					role: "user",
					content: "Earlier context",
					estimatedTokens: 3,
				},
			],
			alreadyCompacted: false,
			mintThreadId: () => "telegram-123-next",
			compactOversizedAttachment: async () => {
				compacted.push("called");
				return [];
			},
		});

		expect(result).toEqual({ ok: true });
		expect(emitter.calls).toEqual([]);
		expect(compacted).toEqual(["called"]);
	});

	test("rejects instead of compacting twice when the turn was already compacted", async () => {
		const session = createProcessSession();
		const compacted: string[] = [];

		const result = await applyTelegramAttachmentBudget({
			session,
			budget: createBudget({ capabilityName: "voice" }),
			content: "x".repeat(48),
			currentMessages: [
				{
					role: "user",
					content: meaningfulContext,
					estimatedTokens: 3,
				},
			],
			alreadyCompacted: true,
			mintThreadId: () => "telegram-123-next",
			compactOversizedAttachment: async () => {
				compacted.push("called");
				return [];
			},
		});

		expect(result).toEqual({
			ok: false,
			userMessage:
				"This voice message is too large for a single turn (≈12 tokens, max 18). Please send a smaller file or split it.",
		});
		expect(compacted).toEqual([]);
	});

	test("allows already-compacted turns to proceed when the refreshed context fits", async () => {
		const session = createProcessSession();
		const compacted: string[] = [];

		const result = await applyTelegramAttachmentBudget({
			session,
			budget: createBudget(),
			content: "x".repeat(40),
			currentMessages: [],
			alreadyCompacted: true,
			mintThreadId: () => "telegram-123-next",
			compactOversizedAttachment: async () => {
				compacted.push("called");
				return [];
			},
		});

		expect(result).toEqual({ ok: true });
		expect(compacted).toEqual([]);
	});

	test("rejects when compaction still does not free enough room", async () => {
		const session = createProcessSession();

		const result = await applyTelegramAttachmentBudget({
			session,
			budget: createBudget(),
			content: "x".repeat(48),
			currentMessages: [
				{
					role: "user",
					content: meaningfulContext,
					estimatedTokens: 3,
				},
			],
			alreadyCompacted: false,
			mintThreadId: () => "telegram-123-next",
			compactOversizedAttachment: async () => [
				{
					role: "system",
					content: "Freshly compacted context",
					estimatedTokens: 3,
				},
			],
		});

		expect(result).toEqual({
			ok: false,
			userMessage:
				"This PDF is too large for a single turn (≈12 tokens, max 18). Please send a smaller file or split it.",
		});
	});

	test("includes one-turn task-check context in the final runtime budget", async () => {
		const session = createProcessSession();
		session.pendingTaskCheckContext = "x".repeat(16);

		const result = await applyTelegramAttachmentBudget({
			session,
			budget: createBudget(),
			content: "x".repeat(48),
			currentMessages: [],
			alreadyCompacted: true,
			mintThreadId: () => "telegram-123-next",
			compactOversizedAttachment: async () => [],
		});

		expect(result).toEqual({
			ok: false,
			userMessage:
				"This PDF is too large for a single turn (≈12 tokens, max 18). Please send a smaller file or split it.",
		});
	});
});
