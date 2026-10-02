import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssistantStore } from '../src/persistence/assistant-store.js';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.js';
import { syntheticConfig } from '../src/assistant/core-test-fixtures.js';
import {
  contextUnderPressure,
  CONTEXT_PRESSURE_RATIO,
} from '../src/assistant/context-pressure.js';
import {
  requestTokens,
  contextLimits,
  assertRequestFits,
} from '../src/providers/assistant-context-budget.js';
import { contextEstimateConfig } from '../src/persistence/assistant-context-estimate.js';
import {
  compactPressureChat,
  compactIdleChat,
} from '../src/assistant/idle-compaction.js';
import { IDLE_COMPACTION_MS } from '../src/persistence/assistant-compaction.js';
import { runAssistant } from '../src/assistant/agent.js';
import { clearChatContext } from '../src/assistant/context.js';
import { AssistantFiles } from '../src/persistence/assistant-files.js';
import type {
  AssistantLlm,
  Completion,
} from '../src/providers/assistant-llm.js';
import { LlmRequestError } from '../src/providers/assistant-llm-error.js';
import type { LlmMessage } from '../src/shared/assistant-types.js';

const stores = new Set<AssistantStore>();
const roots: string[] = [];
const semantic = {
  facts: ['Author prefers tea'],
  decisions: ['Use confirmed date'],
  open_tasks: ['Check venue'],
  sources: ['https://example.invalid/source'],
};
const summary = (): Completion => ({
  message: { role: 'assistant', content: JSON.stringify(semantic) },
});
function fixture(persistent = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'goodkiddo-pressure-'));
  roots.push(root);
  const file = persistent ? path.join(root, 'assistant.db') : ':memory:';
  const store = new AssistantStore(file);
  stores.add(store);
  const config = syntheticConfig();
  config.maxCalls = 6;
  config.maxOutputTokens = 1800;
  config.context.windowTokens = 40_000;
  const chat = {
    id: 'synthetic-pressure',
    type: 'private' as const,
    timezone: 'UTC',
    active: 1,
  };
  store.saveChat(chat);
  for (let i = 0; i < 50; i++)
    store.remember(
      chat.id,
      i % 2 ? 'assistant' : 'user',
      `source-${i} ${'Complete source fact. '.repeat(250)} tail-${i}`,
    );
  const text = 'Continue latest request';
  store.remember(chat.id, 'user', text);
  const request = {
    updateId: 1,
    chat,
    actor: { id: 'author', name: 'Author' },
    text,
    interaction: 'message' as const,
    contextVersion: store.contextVersion(chat.id),
  };
  const taskId = 'pressure-task';
  const analytics = new AssistantAnalytics(config, store);
  analytics.start(taskId, chat, 'author', 'other', 'user');
  const controller = new AbortController();
  return {
    store,
    file,
    config,
    chat,
    chatId: chat.id,
    request,
    taskId,
    analytics,
    controller,
    signal: controller.signal,
  };
}
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const isSummary = (messages: LlmMessage[]) =>
  messages[0].content?.startsWith('Summarize historical');

test('pressure threshold counts output reserve inside min(model window,200k), including tool results', () => {
  const config = syntheticConfig();
  config.maxOutputTokens = 1800;
  config.context.windowTokens = 1_048_576;
  config.context.inputTokens = 524_288;
  const messages: LlmMessage[] = [
    { role: 'user', content: 'Complete source fact. '.repeat(30_000) },
  ];
  const input = requestTokens(messages, [], config);
  expect(contextLimits(config).input).toBe(198_200);
  expect(input).toBeLessThan(198_200);
  expect(contextUnderPressure(messages, [], config)).toBe(false);
  const withResult = [
    ...messages,
    {
      role: 'tool' as const,
      tool_call_id: 'source',
      content: 'Complete result fact. '.repeat(10_000),
    },
  ];
  expect(contextUnderPressure(withResult, [], config)).toBe(true);
  const boundary = syntheticConfig();
  boundary.maxOutputTokens = 100;
  const small: LlmMessage[] = [{ role: 'user', content: 'boundary' }];
  const count = requestTokens(small, [], boundary);
  boundary.context.windowTokens =
    Math.ceil((count + 1) / CONTEXT_PRESSURE_RATIO) + 100;
  expect(contextUnderPressure(small, [], boundary)).toBe(false);
  boundary.context.windowTokens =
    Math.floor(count / CONTEXT_PRESSURE_RATIO) + 100;
  expect(contextUnderPressure(small, [], boundary)).toBe(true);
});

test('pressure performs semantic compaction before foreground generation and replaces history atomically with attributed summary', async () => {
  const s = fixture();
  let summaries = 0;
  let answers = 0;
  const sources: string[] = [];
  const visible: string[] = [];
  const original = s.store
    .history(s.chatId)
    .map((m) => m.content)
    .join('');
  const llm: AssistantLlm = {
    complete: async (messages, tools, _signal, onContent) => {
      assertRequestFits(
        messages,
        tools,
        contextEstimateConfig(s.store, s.config),
      );
      if (isSummary(messages)) {
        summaries++;
        expect(tools).toEqual([]);
        expect(onContent).toBeUndefined();
        sources.push(
          ...messages.slice(2).map((m) => JSON.parse(m.content!).text),
        );
        return summary();
      }
      answers++;
      expect(messages[0].content).toContain('Author prefers tea');
      expect(messages[0].content).toContain('source_archive');
      expect(messages.at(-1)?.content).toBe(s.request.text);
      onContent?.('done');
      return { message: { role: 'assistant', content: 'done' } };
    },
  };
  expect(
    await runAssistant({ ...s, llm, onContent: (text) => visible.push(text) }),
  ).toBe('done');
  expect(visible.filter(Boolean)).toEqual(['done']);
  expect(summaries).toBeGreaterThan(0);
  expect(summaries + answers).toBeLessThanOrEqual(6);
  expect(answers).toBe(1);
  expect(sources.join('')).toBe(original);
  expect(s.store.history(s.chatId)).toEqual([]);
  expect(s.store.memory.read(s.chatId, 1)?.content).toContain('tail-0');
  expect(s.store.memory.read('other-chat', 1)).toBe(null);
  expect(s.store.compaction.status(s.chatId)).toEqual({
    status: 'success',
    trigger: 'pressure',
  });
  expect(s.store.db.query('SELECT id FROM assistant_runs').all()).toHaveLength(
    1,
  );
  expect(s.store.db.query('SELECT * FROM assistant_outbox').all()).toEqual([]);
});

test('failed pressure compaction preserves all source and falls back to bounded whole history with explicit status, once per generation', async () => {
  const s = fixture();
  let summaries = 0;
  let answers = 0;
  const llm: AssistantLlm = {
    complete: async (messages, tools) => {
      assertRequestFits(messages, tools, s.config);
      if (isSummary(messages)) {
        summaries++;
        throw new Error('synthetic summary failure');
      }
      answers++;
      expect(messages[0].content).toContain(
        'Semantic compaction status: error',
      );
      expect(messages[0].content).toContain('Full sources remain archived');
      return { message: { role: 'assistant', content: 'bounded answer' } };
    },
  };
  expect(await runAssistant({ ...s, llm })).toBe('bounded answer');
  expect(await runAssistant({ ...s, llm })).toBe('bounded answer');
  expect(summaries).toBe(1);
  expect(answers).toBe(2);
  expect(s.store.history(s.chatId)).toHaveLength(51);
  expect(s.store.memory.summary(s.chatId)).toBe('');
  expect(s.store.compaction.status(s.chatId)).toEqual({
    status: 'error',
    trigger: 'pressure',
  });
});

test('simultaneous idle and pressure triggers share one claim in either order', async () => {
  for (const idleFirst of [false, true]) {
    const s = fixture();
    s.store.compaction.activity(s.chatId, Date.now() - IDLE_COMPACTION_MS - 1);
    let resolve!: (completion: Completion) => void;
    let calls = 0;
    const llm: AssistantLlm = {
      complete: async () => {
        calls++;
        if (calls === 1)
          return new Promise<Completion>((r) => {
            resolve = r;
          });
        return summary();
      },
    };
    const pending = idleFirst
      ? compactIdleChat({ ...s, llm })
      : compactPressureChat({ ...s, llm });
    expect(await compactIdleChat({ ...s, llm })).toBe(false);
    expect(await compactPressureChat({ ...s, llm })).toBe(false);
    expect(calls).toBe(1);
    resolve(summary());
    expect(await pending).toBe(true);
    expect(
      await compactIdleChat({
        ...s,
        llm,
        now: Date.now() + IDLE_COMPACTION_MS,
      }),
    ).toBe(false);
    expect(s.store.history(s.chatId)).toEqual([]);
    expect(s.store.compaction.status(s.chatId)?.trigger).toBe(
      idleFirst ? 'idle' : 'pressure',
    );
  }
});

test('failed pressure attempts and the additive trigger migration survive restart without replaying unchanged context', async () => {
  let s = fixture(true);
  let calls = 0;
  const llm: AssistantLlm = {
    complete: async () => {
      calls++;
      throw new Error('synthetic failure');
    },
  };
  expect(await compactPressureChat({ ...s, llm })).toBe(false);
  expect(calls).toBe(1);
  s.store.db.exec('ALTER TABLE assistant_compaction DROP COLUMN trigger');
  s.store.close();
  stores.delete(s.store);
  const store = new AssistantStore(s.file);
  stores.add(store);
  s = { ...s, store, analytics: new AssistantAnalytics(s.config, store) };
  expect(await compactPressureChat({ ...s, llm })).toBe(false);
  expect(calls).toBe(1);
  expect(s.store.compaction.status(s.chatId)?.status).toBe('error');
  expect(s.store.history(s.chatId)).toHaveLength(51);
});

test('pressure clear/cancel races cannot commit or restore source, even if the provider ignores abort', async () => {
  for (const clear of [false, true]) {
    const s = fixture();
    let resolve!: (completion: Completion) => void;
    const llm: AssistantLlm = {
      complete: () =>
        new Promise<Completion>((r) => {
          resolve = r;
        }),
    };
    const pending = compactPressureChat({ ...s, llm });
    if (clear) clearChatContext(s.store, s.chatId);
    else s.controller.abort();
    resolve(summary());
    expect(await pending).toBe(false);
    expect(s.store.memory.summary(s.chatId)).toBe('');
    expect(s.store.history(s.chatId)).toHaveLength(clear ? 0 : 51);
    expect(s.store.db.query('SELECT * FROM assistant_outbox').all()).toEqual(
      [],
    );
  }
});

test('pressure reserves the sixth shared model call for the foreground answer without starting a separate budget', async () => {
  const s = fixture();
  s.store.addUsage(s.taskId, {
    llm_calls: 5,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  });
  let calls = 0;
  const llm: AssistantLlm = {
    complete: async (messages) => {
      calls++;
      expect(isSummary(messages)).toBe(false);
      return { message: { role: 'assistant', content: 'bounded answer' } };
    },
  };
  expect(await runAssistant({ ...s, llm })).toBe('bounded answer');
  expect(calls).toBe(1);
  expect(s.store.runUsage(s.taskId).llm_calls).toBe(6);
  expect(s.store.history(s.chatId)).toHaveLength(51);
  expect(s.store.compaction.status(s.chatId)?.status).toBe('error');
});

test('an overflow during semantic compaction retries smaller source batches, then consumes every original segment before commit', async () => {
  const s = fixture();
  let calls = 0;
  const sources: string[] = [];
  const original = s.store
    .history(s.chatId)
    .map((m) => m.content)
    .join('');
  const llm: AssistantLlm = {
    complete: async (messages) => {
      calls++;
      if (calls === 1) throw new LlmRequestError(400, true);
      sources.push(
        ...messages.slice(2).map((m) => JSON.parse(m.content!).text),
      );
      return summary();
    },
  };
  expect(await compactPressureChat({ ...s, llm })).toBe(true);
  expect(calls).toBeLessThanOrEqual(5);
  expect(sources.join('')).toBe(original);
  expect(s.store.history(s.chatId)).toEqual([]);
});

test('a huge tool source stays complete and chat-scoped after pressure compaction; tool side effects are not repeated', async () => {
  const s = fixture();
  let generations = 0;
  let pointer: any;
  const full = s.store.memory.read(s.chatId, 50)!.content;
  const llm: AssistantLlm = {
    complete: async (messages, tools) => {
      if (isSummary(messages)) return summary();
      assertRequestFits(messages, tools, s.config);
      generations++;
      if (generations === 1)
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'read',
                type: 'function',
                function: {
                  name: 'history_search',
                  arguments: '{"query":"Complete source fact","limit":20}',
                },
              },
            ],
          },
        };
      pointer = JSON.parse(messages.at(-1)!.content!);
      return { message: { role: 'assistant', content: 'source retained' } };
    },
  };
  expect(await runAssistant({ ...s, llm })).toBe('source retained');
  expect(generations).toBe(2);
  expect(pointer.inline_omitted).toBe(true);
  const files = new AssistantFiles(s.store.db, s.config.fileLimits);
  const archived = JSON.parse(
    Buffer.from(files.get(s.chatId, pointer.source_path).content).toString(),
  );
  expect(archived.some((source: any) => source.content === full)).toBe(true);
  expect(() => files.get('other-chat', pointer.source_path)).toThrow();
  expect(s.store.runUsage(s.taskId).llm_calls).toBeLessThanOrEqual(6);
});
