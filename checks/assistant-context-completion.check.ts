import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssistantStore } from '../src/persistence/assistant-store.js';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.js';
import { syntheticConfig } from '../src/assistant/core-test-fixtures.js';
import { contextEstimateConfig } from '../src/persistence/assistant-context-estimate.js';
import { TOKEN_ESTIMATOR } from '../src/providers/assistant-token-estimate.js';
import {
  assertRequestFits,
  requestTokens,
  selectHistory,
  textRequestTokens,
} from '../src/providers/assistant-context-budget.js';
import { financialInputAllowance } from '../src/providers/assistant-context-policy.js';
import { meteredCompletion, BudgetExceeded } from '../src/assistant/budget.js';
import {
  CompatibleAssistantLlm,
  type AssistantLlm,
  type Completion,
} from '../src/providers/assistant-llm.js';
import {
  LlmRequestError,
  providerRequestError,
} from '../src/providers/assistant-llm-error.js';
import { runAssistant } from '../src/assistant/agent.js';
import { clearChatContext } from '../src/assistant/context.js';
import type { LlmMessage } from '../src/shared/assistant-types.js';

const stores = new Set<AssistantStore>();
const roots: string[] = [];
const originalFetch = globalThis.fetch;
const result = (): Completion => ({
  message: { role: 'assistant', content: 'done' },
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'goodkiddo-token-estimate-'));
  roots.push(root);
  const file = path.join(root, 'assistant.db');
  const store = new AssistantStore(file);
  stores.add(store);
  const config = syntheticConfig();
  config.maxCalls = 6;
  const chat = {
    id: 'synthetic',
    type: 'private' as const,
    timezone: 'UTC',
    active: 1,
  };
  store.saveChat(chat);
  const analytics = new AssistantAnalytics(config, store);
  const taskId = 'synthetic-task';
  analytics.start(taskId, chat, 'author', 'other', 'user');
  const request = {
    updateId: 1,
    chat,
    actor: { id: 'author', name: 'Author' },
    text: 'Добавь дело',
    interaction: 'message' as const,
    contextVersion: store.contextVersion(chat.id),
  };
  const controller = new AbortController();
  return {
    store,
    file,
    config,
    chat,
    analytics,
    taskId,
    request,
    controller,
    signal: controller.signal,
  };
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const system: LlmMessage = { role: 'system', content: 'instructions' };
const current: LlmMessage[] = [{ role: 'user', content: 'latest' }];
function retryInput(s: ReturnType<typeof fixture>) {
  const history: LlmMessage[] = Array.from({ length: 60 }, (_, i) => ({
    role: 'user',
    content: `source-${i}: ${'old fact '.repeat(150)}`,
  }));
  return {
    messages: [system, ...history, ...current],
    tools: [],
    rebuildContext: (config: typeof s.config, inputLimit: number) =>
      selectHistory({
        system,
        history,
        current,
        tools: [],
        config,
        inputLimit,
      }),
  };
}

test('text usage increases the persisted proxy margin only upward, across restart and without mutating configuration', async () => {
  const s = fixture();
  const messages = [system, ...current];
  const raw = textRequestTokens(messages, []);
  let usage = raw * 2;
  const llm: AssistantLlm = {
    complete: async () => ({
      ...result(),
      usage: { prompt_tokens: usage, completion_tokens: 10 },
    }),
  };
  await meteredCompletion({ ...s, llm, messages, tools: [] });
  expect(
    contextEstimateConfig(s.store, s.config).context.estimateScale,
  ).toBeCloseTo(2.2);
  expect(s.config.context.estimateScale).toBeUndefined();
  expect(s.store.runUsage(s.taskId).tokens_in).toBe(usage);
  usage = 10;
  await meteredCompletion({ ...s, llm, messages, tools: [] });
  expect(
    contextEstimateConfig(s.store, s.config).context.estimateScale,
  ).toBeCloseTo(2.2);
  const saved = s.store.db
    .query(
      "SELECT value FROM assistant_state WHERE key LIKE 'context_estimate:%'",
    )
    .get() as { value: string };
  expect(JSON.parse(saved.value).kind).toBe(TOKEN_ESTIMATOR);
  s.store.close();
  stores.delete(s.store);
  const reopened = new AssistantStore(s.file);
  stores.add(reopened);
  expect(
    contextEstimateConfig(reopened, s.config).context.estimateScale,
  ).toBeCloseTo(2.2);
  expect(
    contextEstimateConfig(reopened, { ...s.config, model: 'another-model' })
      .context.estimateScale,
  ).toBe(1.25);
  expect(
    contextEstimateConfig(reopened, {
      ...s.config,
      baseUrl: 'https://another.invalid',
    }).context.estimateScale,
  ).toBe(1.25);
});

test('missing/invalid usage and image-bearing usage do not calibrate the text tokenizer', async () => {
  const s = fixture();
  for (const prompt of [undefined, NaN, -5, 10.5]) {
    const llm: AssistantLlm = {
      complete: async () => ({
        ...result(),
        usage: { prompt_tokens: prompt, completion_tokens: 1 },
      }),
    };
    await meteredCompletion({ ...s, llm, messages: current, tools: [] });
  }
  const images = [
    {
      filename: 'test.png',
      mimeType: 'image/png',
      bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    },
  ];
  await meteredCompletion({
    ...s,
    images,
    messages: current,
    tools: [],
    llm: {
      complete: async () => ({
        ...result(),
        usage: { prompt_tokens: 100_000, completion_tokens: 10 },
      }),
    },
  });
  expect(contextEstimateConfig(s.store, s.config).context.estimateScale).toBe(
    1.25,
  );
});

test('upward feedback tightens the next request before HTTP or another reservation', async () => {
  const s = fixture();
  s.config.context.windowTokens = 4000;
  let calls = 0;
  const llm: AssistantLlm = {
    complete: async () => {
      calls++;
      return {
        ...result(),
        usage: { prompt_tokens: 3800, completion_tokens: 10 },
      };
    },
  };
  await meteredCompletion({ ...s, llm, messages: current, tools: [] });
  await expect(
    meteredCompletion({ ...s, llm, messages: current, tools: [] }),
  ).rejects.toThrow('превышает');
  expect(calls).toBe(1);
  expect(s.store.runUsage(s.taskId).llm_calls).toBe(1);
  expect(s.store.db.query('SELECT * FROM assistant_spend').all()).toHaveLength(
    1,
  );
});

test('HTTP overflow shrinks whole history once while preserving executed tool calls/results and their side effects', async () => {
  const s = fixture();
  for (let i = 0; i < 60; i++)
    s.store.remember(
      s.chat.id,
      'user',
      `old-${i} ${'old source fact '.repeat(150)}`,
    );
  s.store.remember(s.chat.id, 'user', s.request.text);
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (bodies.length === 1)
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'todo',
                  type: 'function',
                  function: {
                    name: 'todo_add',
                    arguments: '{"title":"Only once"}',
                  },
                },
              ],
            },
          },
        ],
      });
    if (bodies.length === 2)
      return Response.json(
        {
          error: {
            code: 'context_length_exceeded',
            message: 'maximum context length is 524288 tokens; private source',
          },
        },
        { status: 400 },
      );
    return Response.json({
      choices: [{ message: result().message }],
      usage: { prompt_tokens: 1000, completion_tokens: 10 },
    });
  }) as typeof fetch;
  expect(
    await runAssistant({ ...s, llm: new CompatibleAssistantLlm(s.config) }),
  ).toBe('done');
  expect(bodies).toHaveLength(3);
  expect(bodies[2].messages.length).toBeLessThan(bodies[1].messages.length);
  expect(bodies[2].messages.at(-1)).toEqual(bodies[1].messages.at(-1));
  expect(bodies[2].messages.at(-2)).toEqual(bodies[1].messages.at(-2));
  expect(
    bodies[2].messages.some((m: LlmMessage) => m.content === s.request.text),
  ).toBe(true);
  expect(s.store.todos.list(s.chat.id)).toHaveLength(1);
  expect(s.store.runUsage(s.taskId).llm_calls).toBe(3);
  expect(s.store.history(s.chat.id)).toHaveLength(61);
});

test('only explicit context overflow is retryable; ordinary 400/413, quota, auth and rate errors stay classified safely', async () => {
  expect(
    providerRequestError(400, { error: { code: 'context_length_exceeded' } })
      .contextOverflow,
  ).toBe(true);
  expect(
    providerRequestError(200, { error: { code: 'context_length_exceeded' } })
      .contextOverflow,
  ).toBe(true);
  for (const [status, message] of [
    [400, 'invalid field'],
    [413, 'request entity too large'],
    [401, 'maximum context length'],
    [429, 'context_length_exceeded rate limit'],
  ]) {
    const error = providerRequestError(status as number, {
      error: { message },
    });
    expect(error.contextOverflow).toBe(false);
    expect(error.message).not.toContain(String(message));
  }
  const s = fixture();
  let calls = 0;
  const llm: AssistantLlm = {
    complete: async () => {
      calls++;
      throw new LlmRequestError(413);
    },
  };
  await expect(
    meteredCompletion({ ...s, ...retryInput(s), llm }),
  ).rejects.toBeInstanceOf(LlmRequestError);
  expect(calls).toBe(1);
});

test('stream context-overflow events retain their classification and never retain the private error text', async () => {
  const s = fixture();
  globalThis.fetch = (async () =>
    new Response(
      'data: {"error":{"code":"context_length_exceeded","message":"private original source"}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
  let error: any;
  try {
    await new CompatibleAssistantLlm(s.config).complete(
      current,
      [],
      s.signal,
      () => {},
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(LlmRequestError);
  expect(error.contextOverflow).toBe(true);
  expect(error.message).not.toContain('private original source');
});

test('oversized/non-JSON error bodies cannot trigger retries or leak source text', async () => {
  const s = fixture();
  for (const body of [
    '<html>private original source</html>',
    JSON.stringify({
      error: {
        code: 'context_length_exceeded',
        message: 'private '.repeat(4000),
      },
    }),
  ]) {
    globalThis.fetch = (async () =>
      new Response(body, { status: 413 })) as unknown as typeof fetch;
    let error: any;
    try {
      await new CompatibleAssistantLlm(s.config).complete(
        current,
        [],
        s.signal,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error.contextOverflow).toBe(false);
    expect(error.message).not.toContain('private');
  }
});

test('a second overflow is returned; the one-per-task retry allowance persists across restart', async () => {
  const s = fixture();
  let calls = 0;
  const llm: AssistantLlm = {
    complete: async () => {
      calls++;
      throw new LlmRequestError(400, true);
    },
  };
  await expect(
    meteredCompletion({ ...s, ...retryInput(s), llm }),
  ).rejects.toBeInstanceOf(LlmRequestError);
  expect(calls).toBe(2);
  s.store.close();
  stores.delete(s.store);
  const store = new AssistantStore(s.file);
  stores.add(store);
  await expect(
    meteredCompletion({ ...s, store, ...retryInput(s), llm }),
  ).rejects.toBeInstanceOf(LlmRequestError);
  expect(calls).toBe(3);
  expect(store.runUsage(s.taskId).llm_calls).toBe(3);
});

test('the sixth shared call, a reserved outer slot, and monthly reservations each prevent an extra retry', async () => {
  for (const mode of ['sixth', 'outer-slot', 'monthly']) {
    const s = fixture();
    const input = retryInput(s);
    let calls = 0;
    if (mode === 'sixth')
      s.store.addUsage(s.taskId, {
        llm_calls: 5,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
      });
    if (mode === 'outer-slot')
      s.store.addUsage(s.taskId, {
        llm_calls: 4,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
      });
    if (mode === 'monthly') {
      s.config.inputPrice = 1;
      s.config.monthlyBudget =
        Math.max(
          requestTokens(input.messages, [], s.config),
          financialInputAllowance(input.messages, []),
        ) / 1e6;
    }
    const llm: AssistantLlm = {
      complete: async () => {
        calls++;
        throw new LlmRequestError(400, true);
      },
    };
    await expect(
      meteredCompletion({
        ...s,
        ...input,
        llm,
        callLimit: mode === 'outer-slot' ? 5 : undefined,
      }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(calls).toBe(1);
    expect(s.store.runUsage(s.taskId).llm_calls).toBe(
      mode === 'sixth' ? 6 : mode === 'outer-slot' ? 5 : 1,
    );
  }
});

test('clear/cancel after a rejected call prevents the retry and never restores private history', async () => {
  for (const clear of [false, true]) {
    const s = fixture();
    s.store.remember(s.chat.id, 'user', 'full original');
    let calls = 0;
    const llm: AssistantLlm = {
      complete: async () => {
        calls++;
        if (clear) clearChatContext(s.store, s.chat.id);
        else s.controller.abort();
        throw new LlmRequestError(400, true);
      },
    };
    await expect(
      meteredCompletion({ ...s, ...retryInput(s), llm }),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
    expect(s.store.history(s.chat.id)).toHaveLength(clear ? 0 : 1);
  }
});

test('an irreducible mandatory request is not retried unchanged', async () => {
  const s = fixture();
  let calls = 0;
  const llm: AssistantLlm = {
    complete: async () => {
      calls++;
      throw new LlmRequestError(400, true);
    },
  };
  await expect(
    meteredCompletion({
      ...s,
      llm,
      messages: current,
      tools: [],
      rebuildContext: (_config, inputLimit) => {
        assertRequestFits(current, [], s.config, [], inputLimit);
        return current;
      },
    }),
  ).rejects.toBeInstanceOf(LlmRequestError);
  expect(calls).toBe(1);
});
