import { describe, expect, test } from "bun:test";
import type { Bot } from "grammy";
import { CapabilityRegistry } from "../capabilities/registry";
import type { FileCapability } from "../capabilities/types";
import type { AppConfig } from "../config";
import { PermissionsStore } from "../permissions/store";
import type { StatusEmitter } from "../tools/status_emitter";
import { processTelegramFile } from "./telegram";

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
  enableToolStatus: true,
  enableAttachmentCompactionNotice: true,
  defaultStatusLocale: "en",
  transcriptionProvider: "openai",
  transcriptionApiKey: "test-key",
  transcriptionBaseUrl: "",
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
): CapabilityRegistry {
  const capability: FileCapability = {
    name,
    canHandle: () => true,
    async process() {
      return {
        ok: true,
        value: {
          content,
          currentUserText: content,
        },
      };
    },
  };

  return new CapabilityRegistry([capability]);
}

function createProcessSession(statusEmitter?: StatusEmitter): TelegramProcessSession {
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

describe("telegram attachment budget handling", () => {
  const caller = {
    id: "telegram:123",
    entrypoint: "telegram" as const,
    externalId: "123",
  };

  test("rejects oversized attachment before queueing a turn", async () => {
    const sent: string[] = [];
    const queued: unknown[][] = [];
    const compacted: string[] = [];

    await processTelegramFile(
      ATTACHMENT_TEST_CONFIG,
      createAttachmentRegistry("pdf", "x".repeat(76)),
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
        sendMessage: async (_bot, _chatId, text) => {
          sent.push(text);
        },
        queueTurn: async (...args) => {
          queued.push(args);
          return undefined;
        },
        loadCurrentMessages: async () => [],
        prepareTurn: async (_session, messages) => ({
          currentMessages: messages,
          compacted: false,
        }),
        estimateRuntimeTokens: () => 0,
        compactOversizedAttachment: async () => {
          compacted.push("called");
          return [];
        },
      },
    );

    expect(sent).toEqual([
      "This PDF is too large for a single turn (≈19 tokens, max 18). Please send a smaller file or split it.",
    ]);
    expect(queued).toHaveLength(0);
    expect(compacted).toHaveLength(0);
  });

  test("triggers oversized_attachment compaction for mid-range attachments", async () => {
    const sent: string[] = [];
    const queued: unknown[][] = [];
    const compacted: string[] = [];
    const emitter = new FakeStatusEmitter();

    await processTelegramFile(
      ATTACHMENT_TEST_CONFIG,
      createAttachmentRegistry("spreadsheet", "x".repeat(60)),
      createProcessSession(emitter),
      {} as Bot,
      "123",
      caller,
      {} as PermissionsStore,
      undefined,
      {
        metadata: { mimeType: "text/csv", filename: "sheet.csv" },
        download: async () => Uint8Array.from([1, 2, 3]),
      },
      {
        sendMessage: async (_bot, _chatId, text) => {
          sent.push(text);
        },
        queueTurn: async (...args) => {
          queued.push(args);
          return undefined;
        },
        loadCurrentMessages: async () => [],
        prepareTurn: async (_session, messages) => ({
          currentMessages: messages,
          compacted: false,
        }),
        estimateRuntimeTokens: () => 0,
        compactOversizedAttachment: async () => {
          compacted.push("called");
          return [];
        },
      },
    );

    expect(sent).toEqual([]);
    expect(emitter.calls).toEqual([
      {
        callerId: "telegram:123",
        message:
          "Summarizing older messages to make room for this attachment...",
      },
    ]);
    expect(compacted).toEqual(["called"]);
    expect(queued).toHaveLength(1);
  });

  test("does not emit compaction notice when flag is disabled", async () => {
    const sent: string[] = [];
    const queued: unknown[][] = [];
    const compacted: string[] = [];
    const emitter = new FakeStatusEmitter();

    await processTelegramFile(
      { ...ATTACHMENT_TEST_CONFIG, enableAttachmentCompactionNotice: false },
      createAttachmentRegistry("spreadsheet", "x".repeat(60)),
      createProcessSession(emitter),
      {} as Bot,
      "123",
      caller,
      {} as PermissionsStore,
      undefined,
      {
        metadata: { mimeType: "text/csv", filename: "sheet.csv" },
        download: async () => Uint8Array.from([1, 2, 3]),
      },
      {
        sendMessage: async (_bot, _chatId, text) => {
          sent.push(text);
        },
        queueTurn: async (...args) => {
          queued.push(args);
          return undefined;
        },
        loadCurrentMessages: async () => [],
        prepareTurn: async (_session, messages) => ({
          currentMessages: messages,
          compacted: false,
        }),
        estimateRuntimeTokens: () => 0,
        compactOversizedAttachment: async () => {
          compacted.push("called");
          return [];
        },
      },
    );

    expect(sent).toEqual([]);
    expect(emitter.calls).toEqual([]);
    expect(compacted).toEqual(["called"]);
    expect(queued).toHaveLength(1);
  });

  test("skips a second compaction and rejects when a fresh compacted context still cannot fit", async () => {
    const sent: string[] = [];
    const queued: unknown[][] = [];
    const compacted: string[] = [];

    await processTelegramFile(
      ATTACHMENT_TEST_CONFIG,
      createAttachmentRegistry("voice", "x".repeat(60)),
      createProcessSession(),
      {} as Bot,
      "123",
      caller,
      {} as PermissionsStore,
      undefined,
      {
        metadata: { mimeType: "audio/ogg", filename: "voice.ogg" },
        download: async () => Uint8Array.from([1, 2, 3]),
      },
      {
        sendMessage: async (_bot, _chatId, text) => {
          sent.push(text);
        },
        queueTurn: async (...args) => {
          queued.push(args);
          return undefined;
        },
        loadCurrentMessages: async () => [],
        prepareTurn: async (_session, messages) => ({
          currentMessages: messages,
          compacted: true,
        }),
        estimateRuntimeTokens: () => 1,
        compactOversizedAttachment: async () => {
          compacted.push("called");
          return [];
        },
      },
    );

    expect(sent).toEqual([
      "This voice message is too large for a single turn (≈15 tokens, max 17). Please send a smaller file or split it.",
    ]);
    expect(queued).toHaveLength(0);
    expect(compacted).toHaveLength(0);
  });

  test("leaves small attachments unchanged", async () => {
    const sent: string[] = [];
    const queued: unknown[][] = [];
    const compacted: string[] = [];

    await processTelegramFile(
      ATTACHMENT_TEST_CONFIG,
      createAttachmentRegistry("pdf", "x".repeat(40)),
      createProcessSession(),
      {} as Bot,
      "123",
      caller,
      {} as PermissionsStore,
      undefined,
      {
        metadata: { mimeType: "application/pdf", filename: "brief.pdf" },
        download: async () => Uint8Array.from([1, 2, 3]),
      },
      {
        sendMessage: async (_bot, _chatId, text) => {
          sent.push(text);
        },
        queueTurn: async (...args) => {
          queued.push(args);
          return undefined;
        },
        loadCurrentMessages: async () => [],
        prepareTurn: async (_session, messages) => ({
          currentMessages: messages,
          compacted: false,
        }),
        estimateRuntimeTokens: () => 0,
        compactOversizedAttachment: async () => {
          compacted.push("called");
          return [];
        },
      },
    );

    expect(sent).toEqual([]);
    expect(compacted).toHaveLength(0);
    expect(queued).toHaveLength(1);
  });
});
