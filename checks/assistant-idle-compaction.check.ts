import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssistantStore } from '../src/persistence/assistant-store.js';
import { IDLE_COMPACTION_MS } from '../src/persistence/assistant-compaction.js';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.js';
import {
  syntheticApi,
  syntheticConfig,
} from '../src/assistant/core-test-fixtures.js';
import { compactIdleChat } from '../src/assistant/idle-compaction.js';
import {
  clearChatContext,
  noteUserActivity,
} from '../src/assistant/context.js';
import { AssistantWorker } from '../src/assistant/worker.js';
import { runAssistant } from '../src/assistant/agent.js';
import { AssistantFiles } from '../src/persistence/assistant-files.js';
import type {
  AssistantLlm,
  Completion,
} from '../src/providers/assistant-llm.js';
import type { LlmMessage } from '../src/shared/assistant-types.js';
import { assertRequestFits } from '../src/providers/assistant-context-budget.js';
import { executeCoreTool } from '../src/assistant/core-tools.js';
import type { ToolContext } from '../src/assistant/tools.js';

const roots: string[] = [];
const stores = new Set<AssistantStore>();
const summary = {
  facts: ['Author prefers tea'],
  decisions: ['Use the confirmed date'],
  open_tasks: ['Check venue'],
  sources: ['https://example.invalid/source'],
};
function completion(): Completion {
  return {
    message: { role: 'assistant', content: JSON.stringify(summary) },
    usage: { prompt_tokens: 400, completion_tokens: 100 },
  };
}
function fixture(persistent = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'goodkiddo-compaction-'));
  roots.push(root);
  const file = persistent ? path.join(root, 'assistant.db') : ':memory:';
  const store = new AssistantStore(file);
  stores.add(store);
  const chat = {
    id: 'synthetic-a',
    type: 'private' as const,
    timezone: 'UTC',
    active: 1,
  };
  store.saveChat(chat);
  store.remember(
    chat.id,
    'user',
    'Author prefers tea. Decision: use confirmed date. Open task: check venue. Source https://example.invalid/source',
  );
  store.remember(
    chat.id,
    'assistant',
    'Will check venue; no booking was made.',
  );
  const now = Date.now();
  store.compaction.activity(chat.id, now - IDLE_COMPACTION_MS);
  const config = syntheticConfig();
  config.maxCalls = 6;
  const analytics = new AssistantAnalytics(config, store);
  const signal = new AbortController().signal;
  const llm: AssistantLlm = { complete: async () => completion() };
  return {
    store,
    file,
    chat,
    config,
    analytics,
    signal,
    llm,
    chatId: chat.id,
    now,
  };
}
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function outbox(store: AssistantStore) {
  return store.db.query('SELECT * FROM assistant_outbox').all();
}
function reopen(s: ReturnType<typeof fixture>) {
  s.store.close();
  stores.delete(s.store);
  const store = new AssistantStore(s.file);
  stores.add(store);
  return { ...s, store, analytics: new AssistantAnalytics(s.config, store) };
}

test('one idle hour triggers semantic model summary once; full archive and explicit memory survive silently', async () => {
  const s = fixture();
  let calls = 0;
  s.llm = {
    complete: async (messages, tools) => {
      calls++;
      expect(tools).toEqual([]);
      expect(messages[0].content).toContain('untrusted historical DATA');
      expect(messages.map((m) => m.content).join('')).toContain('source_id');
      return completion();
    },
  };
  s.store.memory.write(s.chatId, 'author', 'tea', 'prefers tea', 'preference');
  s.store.todos.add(s.chatId, 'author', 'check venue', 'origin');
  expect(await compactIdleChat({ ...s, now: s.now - 1 })).toBe(false);
  expect(calls).toBe(0);
  expect(await compactIdleChat(s)).toBe(true);
  expect(s.store.history(s.chatId)).toEqual([]);
  expect(s.store.memory.summary(s.chatId)).toContain('Check venue');
  expect(s.store.memory.summary(s.chatId)).toContain('source_archive');
  expect(s.store.memory.read(s.chatId, 1)?.content).toContain(
    'Author prefers tea',
  );
  expect(s.store.memory.read('other-chat', 1)).toBe(null);
  expect(s.store.memory.list(s.chatId)).toHaveLength(1);
  expect(s.store.todos.list(s.chatId)).toHaveLength(1);
  expect(outbox(s.store)).toEqual([]);
  expect(
    await compactIdleChat({ ...s, now: s.now + IDLE_COMPACTION_MS * 10 }),
  ).toBe(false);
  expect(calls).toBe(1);
  const run = s.store.db.query('SELECT * FROM assistant_runs').get() as any;
  expect(run).toMatchObject({
    status: 'success',
    llm_calls: 1,
    tokens_in: 400,
    tokens_out: 100,
    user_id: null,
  });
});
test('new activity resets the hour and a new generation can compact after its next idle hour', async () => {
  const s = fixture();
  s.store.compaction.activity(s.chatId, s.now);
  expect(await compactIdleChat(s)).toBe(false);
  expect(await compactIdleChat({ ...s, now: s.now + IDLE_COMPACTION_MS })).toBe(
    true,
  );
  s.store.remember(s.chatId, 'user', 'new material');
  s.store.compaction.activity(s.chatId, s.now + IDLE_COMPACTION_MS);
  expect(await compactIdleChat({ ...s, now: s.now + IDLE_COMPACTION_MS })).toBe(
    false,
  );
  expect(
    await compactIdleChat({ ...s, now: s.now + 2 * IDLE_COMPACTION_MS }),
  ).toBe(true);
  expect(
    JSON.parse(s.store.memory.summary(s.chatId)).source_archive.first_id,
  ).toBe(1);
});

test('duplicate Telegram activity does not restart the clock or invalidate a claimed generation', () => {
  const s = fixture();
  noteUserActivity(s.store, s.chatId, 20);
  s.store.compaction.activity(s.chatId, s.now - IDLE_COMPACTION_MS);
  const claim = s.store.compaction.claim(s.chatId, s.now)!;
  noteUserActivity(s.store, s.chatId, 20);
  noteUserActivity(s.store, s.chatId, 19);
  expect(s.store.compaction.current(claim)).toBe(true);
  noteUserActivity(s.store, s.chatId, 21);
  expect(s.store.compaction.current(claim)).toBe(false);
});

test('real worker wake runs idle compaction silently and repeated wakes do not call the model', async () => {
  const s = fixture();
  s.store.compaction.activity(s.chatId, Date.now() - IDLE_COMPACTION_MS - 1);
  let calls = 0;
  s.llm = {
    complete: async () => {
      calls++;
      return completion();
    },
  };
  const worker = new AssistantWorker(
    s.config,
    s.store,
    s.analytics,
    s.llm,
    syntheticApi(),
  );
  worker.wake();
  worker.wake();
  await worker.idle();
  worker.wake();
  await worker.idle();
  expect(calls).toBe(1);
  expect(outbox(s.store)).toEqual([]);
  await worker.stop();
});
test('new user message aborts in-flight compaction; ignored abort still cannot commit stale summary', async () => {
  const s = fixture();
  let resolve!: (result: Completion) => void;
  let observed!: AbortSignal;
  s.llm = {
    complete: async (_messages, _tools, signal) => {
      observed = signal;
      return new Promise<Completion>((r) => {
        resolve = r;
      });
    },
  };
  const pending = compactIdleChat(s);
  expect(observed.aborted).toBe(false);
  noteUserActivity(s.store, s.chatId);
  s.store.remember(s.chatId, 'user', 'new decision');
  expect(observed.aborted).toBe(true);
  resolve(completion());
  expect(await pending).toBe(false);
  expect(s.store.history(s.chatId)).toHaveLength(3);
  expect(s.store.memory.summary(s.chatId)).toBe('');
  expect(s.store.memory.read(s.chatId, 1)).not.toBe(null);
  expect(outbox(s.store)).toEqual([]);
});
test('clear and cancellation suppress an in-flight summary and never restore cleared context', async () => {
  for (const clear of [false, true]) {
    const s = fixture();
    const controller = new AbortController();
    let resolve!: (result: Completion) => void;
    s.llm = {
      complete: () =>
        new Promise((r) => {
          resolve = r;
        }),
    };
    const pending = compactIdleChat({ ...s, signal: controller.signal });
    if (clear) clearChatContext(s.store, s.chatId);
    else controller.abort();
    resolve(completion());
    expect(await pending).toBe(false);
    expect(s.store.memory.summary(s.chatId)).toBe('');
    expect(s.store.history(s.chatId)).toHaveLength(clear ? 0 : 2);
    expect(s.store.memory.search(s.chatId, 'tea')).toHaveLength(clear ? 0 : 1);
    expect(outbox(s.store)).toEqual([]);
  }
});
test('failed/invalid/action summaries preserve sources and old summary; no repeated idle calls', async () => {
  for (const mode of ['failure', 'invalid', 'actions']) {
    const s = fixture();
    s.store.memory.setSummary(s.chatId, 'prior decisions');
    let calls = 0;
    s.llm = {
      complete: async () => {
        calls++;
        if (mode === 'failure') throw new Error('synthetic failure');
        const result = completion();
        if (mode === 'invalid') result.message.content = 'arbitrary excerpt';
        else
          result.message.tool_calls = [
            {
              id: 'x',
              type: 'function',
              function: { name: 'write_file', arguments: '{}' },
            },
          ];
        return result;
      },
    };
    expect(await compactIdleChat(s)).toBe(false);
    expect(
      await compactIdleChat({ ...s, now: s.now + IDLE_COMPACTION_MS * 100 }),
    ).toBe(false);
    expect(calls).toBe(1);
    expect(s.store.history(s.chatId)).toHaveLength(2);
    expect(s.store.memory.summary(s.chatId)).toBe('prior decisions');
    expect(outbox(s.store)).toEqual([]);
  }
});
test('pending foreground request, inactive chat, other chat and concurrent wake cannot steal a claim', async () => {
  const s = fixture();
  let resolve!: (result: Completion) => void;
  s.llm = {
    complete: () =>
      new Promise((r) => {
        resolve = r;
      }),
  };
  const pending = compactIdleChat(s);
  expect(await compactIdleChat(s)).toBe(false);
  expect(await compactIdleChat({ ...s, chatId: 'other' })).toBe(false);
  resolve(completion());
  await pending;
  const other = fixture();
  other.store.enqueue({
    updateId: 1,
    chat: other.chat,
    actor: { id: 'author', name: 'Author' },
    text: 'request',
    interaction: 'message',
  });
  other.store.compaction.activity(other.chatId, other.now - IDLE_COMPACTION_MS);
  expect(await compactIdleChat(other)).toBe(false);
  other.store.requestStatus(1, 'done');
  other.store.saveChat({ ...other.chat, active: 0 });
  expect(await compactIdleChat(other)).toBe(false);
});
test('restart recovers an overdue unclaimed chat; successful generation never repeats after reopen', async () => {
  let s = fixture(true);
  s = reopen(s);
  expect(await compactIdleChat(s)).toBe(true);
  s = reopen(s);
  expect(
    await compactIdleChat({ ...s, now: s.now + 10 * IDLE_COMPACTION_MS }),
  ).toBe(false);
  expect(s.store.memory.read(s.chatId, 1)?.content).toContain('tea');
  expect(s.store.memory.summary(s.chatId)).toContain('Check venue');
});

test('first upgrade restores complete legacy archive sources once rather than summarizing the extractive digest', async () => {
  let s = fixture(true);
  for (let i = 0; i < 60; i++)
    s.store.remember(
      s.chatId,
      'user',
      `full-old-source-${i} ${'x'.repeat(1500)} important tail fact-${i}`,
    );
  s.store.db
    .query(
      'DELETE FROM assistant_history WHERE chat_id=? AND id NOT IN (SELECT id FROM assistant_history WHERE chat_id=? ORDER BY id DESC LIMIT 24)',
    )
    .run(s.chatId, s.chatId);
  s.store.db.query('DELETE FROM assistant_compaction').run();
  s.store.memory.setSummary(
    s.chatId,
    'legacy first 800 characters without important tail facts',
  );
  s = reopen(s);
  expect(s.store.history(s.chatId)).toHaveLength(62);
  s.store.compaction.activity(s.chatId, s.now - IDLE_COMPACTION_MS);
  const sources: string[] = [];
  s.llm = {
    complete: async (messages) => {
      sources.push(
        ...messages.slice(2).map((m) => JSON.parse(m.content!).text),
      );
      return completion();
    },
  };
  expect(await compactIdleChat(s)).toBe(true);
  expect(sources.join('')).toContain('important tail fact-0');
  expect(sources.join('')).toContain('important tail fact-59');
  s = reopen(s);
  expect(s.store.history(s.chatId)).toEqual([]);
  expect(s.store.memory.search(s.chatId, 'full-old-source-0')).toHaveLength(1);
});

test('failed summary is not replayed on restart, and changed summary invalidates the atomic commit', async () => {
  let s = fixture(true);
  let calls = 0;
  s.llm = {
    complete: async () => {
      calls++;
      throw new Error('synthetic');
    },
  };
  expect(await compactIdleChat(s)).toBe(false);
  s = reopen(s);
  expect(await compactIdleChat({ ...s, now: s.now + IDLE_COMPACTION_MS })).toBe(
    false,
  );
  expect(calls).toBe(1);
  s.store.compaction.activity(s.chatId, s.now - IDLE_COMPACTION_MS);
  let resolve!: (result: Completion) => void;
  s.llm = {
    complete: () =>
      new Promise((r) => {
        resolve = r;
      }),
  };
  const pending = compactIdleChat(s);
  s.store.memory.setSummary(s.chatId, 'new manual summary');
  resolve(completion());
  expect(await pending).toBe(false);
  expect(s.store.memory.summary(s.chatId)).toBe('new manual summary');
  expect(s.store.history(s.chatId)).toHaveLength(2);
});

test('compaction failure after a later source chunk leaves all original context and archive intact', async () => {
  const s = fixture();
  s.store.remember(s.chatId, 'user', 'Long source facts '.repeat(20000));
  let calls = 0;
  s.llm = {
    complete: async () => {
      calls++;
      if (calls > 1) throw new Error('synthetic late failure');
      return completion();
    },
  };
  expect(await compactIdleChat(s)).toBe(false);
  expect(calls).toBe(2);
  expect(s.store.history(s.chatId)).toHaveLength(3);
  expect(s.store.memory.read(s.chatId, 3)?.content).toBe(
    'Long source facts '.repeat(20000),
  );
  expect(s.store.memory.summary(s.chatId)).toBe('');
});
test('interrupted claim is not replayed after restart; worker recovery sends no compaction notification', async () => {
  let s = fixture(true);
  const claim = s.store.compaction.claim(s.chatId, s.now)!;
  s.analytics.start(
    `context-compaction:${claim.token}`,
    s.chat,
    null,
    'other',
    'bot',
  );
  s = reopen(s);
  const worker = new AssistantWorker(
    s.config,
    s.store,
    s.analytics,
    s.llm,
    syntheticApi(),
  );
  worker.recoverInterrupted();
  expect(
    await compactIdleChat({ ...s, now: s.now + 10 * IDLE_COMPACTION_MS }),
  ).toBe(false);
  expect(outbox(s.store)).toEqual([]);
  expect(s.store.history(s.chatId)).toHaveLength(2);
  expect(
    (s.store.db.query('SELECT status FROM assistant_runs').get() as any).status,
  ).toBe('cancelled');
  await worker.stop();
});
test('monthly and daily limits stop compaction before model call; usage stays bounded and voice cap unchanged', async () => {
  for (const mode of ['monthly', 'daily']) {
    const s = fixture();
    let calls = 0;
    s.llm = {
      complete: async () => {
        calls++;
        return completion();
      },
    };
    if (mode === 'monthly') s.config.inputPrice = 1;
    else
      for (let i = 0; i < s.config.dailyChatTasks; i++)
        s.store.startRun(`existing-${i}`, s.chat, 'author', 'other');
    expect(await compactIdleChat(s)).toBe(false);
    expect(calls).toBe(0);
    expect(s.store.history(s.chatId)).toHaveLength(2);
    expect(outbox(s.store)).toEqual([]);
    expect(s.config.voice.monthlyBudget).toBeLessThanOrEqual(5);
  }
});
test('long sources are summarized across bounded calls; all source segments are consumed before atomic commit', async () => {
  const s = fixture();
  const full = 'α🙂 large fact. '.repeat(18000);
  s.store.remember(s.chatId, 'user', full);
  const pieces: string[] = [];
  let calls = 0;
  s.llm = {
    complete: async (messages, tools) => {
      calls++;
      assertRequestFits(messages, tools, s.config);
      for (const message of messages.slice(2)) {
        const source = JSON.parse(message.content!);
        if (source.source_id === 3) pieces.push(source.text);
      }
      if (calls > 1) expect(messages[1].content).toContain('Check venue');
      return completion();
    },
  };
  expect(await compactIdleChat(s)).toBe(true);
  expect(calls).toBeGreaterThan(1);
  expect(calls).toBeLessThanOrEqual(6);
  expect(pieces.join('')).toBe(full);
  expect(s.store.memory.read(s.chatId, 3)?.content).toBe(full);
});
test('shared model-call ceiling prevents partial compaction from discarding unsummarized source', async () => {
  const s = fixture();
  s.config.maxCalls = 1;
  s.store.remember(s.chatId, 'user', 'large full source '.repeat(20000));
  let calls = 0;
  s.llm = {
    complete: async () => {
      calls++;
      return completion();
    },
  };
  expect(await compactIdleChat(s)).toBe(false);
  expect(calls).toBe(1);
  expect(s.store.history(s.chatId)).toHaveLength(3);
  expect(s.store.memory.summary(s.chatId)).toBe('');
});
test('long tool result becomes a complete chat-scoped source with a bounded reference, never a chopped excerpt', async () => {
  const s = fixture();
  const data = 'Full source fact. '.repeat(20000);
  s.store.memory.write(s.chatId, 'author', 'source', 'stored fact', 'fact');
  // history_search can return multiple full messages, exceeding the inline budget.
  s.store.remember(s.chatId, 'user', data);
  s.store.remember(s.chatId, 'user', 'read older source');
  s.analytics.start('foreground', s.chat, 'author', 'other', 'user');
  let calls = 0;
  const seen: LlmMessage[][] = [];
  s.llm = {
    complete: async (messages, tools) => {
      assertRequestFits(messages, tools, s.config);
      seen.push(messages);
      calls++;
      if (calls === 1)
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
                  arguments: '{"query":"Full source fact"}',
                },
              },
            ],
          },
        };
      const pointer = JSON.parse(messages.at(-1)!.content!);
      expect(pointer.inline_omitted).toBe(true);
      expect(pointer.excerpt).toBeUndefined();
      const files = new AssistantFiles(s.store.db, s.config.fileLimits);
      const fullResult = JSON.parse(
        Buffer.from(
          files.get(s.chatId, pointer.source_path).content,
        ).toString(),
      );
      expect(fullResult[0].content).toBe(data);
      expect(() => files.get('other-chat', pointer.source_path)).toThrow();
      return {
        message: {
          role: 'assistant',
          content: 'source stored; continue reading by pages',
        },
      };
    },
  };
  await runAssistant({
    ...s,
    request: {
      updateId: 1,
      chat: s.chat,
      actor: { id: 'author', name: 'Author' },
      text: 'read older source',
      interaction: 'message',
    },
    taskId: 'foreground',
  });
  expect(calls).toBe(2);
  expect(s.store.history(s.chatId)).toHaveLength(4);
  expect(s.store.memory.read(s.chatId, 3)?.content).toBe(data);
});

test('archived oversized tool JSON can be read fully across long single-line strings and Unicode boundaries', () => {
  const s = fixture();
  const ctx: ToolContext = {
    ...s,
    taskId: 'source-read',
    searches: 0,
    request: {
      updateId: 1,
      chat: s.chat,
      actor: { id: 'author', name: 'Author' },
      text: 'read',
      interaction: 'message',
    },
  };
  const files = new AssistantFiles(s.store.db, s.config.fileLimits);
  const data = JSON.stringify({
    long_value: '🙂 single-line fact '.repeat(1000),
  });
  const filePath = '/context/tool-results/synthetic.json';
  files.write(
    s.chatId,
    filePath,
    new TextEncoder().encode(data),
    'application/json',
  );
  let offset: number | null = 0;
  let text = '';
  while (offset !== null) {
    const result = executeCoreTool(
      'context_result_read',
      JSON.stringify({ file_path: filePath, offset, limit: 123 }),
      ctx,
    ) as { text: string; next_offset: number | null };
    expect(result.next_offset === null || result.next_offset > offset).toBe(
      true,
    );
    text += result.text;
    offset = result.next_offset;
  }
  expect(text).toBe(data);
  files.write(
    s.chatId,
    '/context/tool-results/unicode.json',
    new TextEncoder().encode('🙂'),
  );
  const unicode = executeCoreTool(
    'context_result_read',
    '{"file_path":"/context/tool-results/unicode.json","limit":1}',
    ctx,
  ) as any;
  expect(unicode.text).toBe('🙂');
  expect(unicode.next_offset).toBe(null);
  expect(() =>
    executeCoreTool(
      'context_result_read',
      JSON.stringify({ file_path: filePath }),
      { ...ctx, request: { ...ctx.request, chat: { ...s.chat, id: 'other' } } },
    ),
  ).toThrow();
});
