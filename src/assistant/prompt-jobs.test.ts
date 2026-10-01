import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssistantStore } from '../persistence/assistant-store.js';
import { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import type { PromptJobInput } from '../persistence/assistant-prompt-jobs.js';
import type {
  NotificationMode,
  InboundRequest,
} from '../shared/assistant-types.js';
import type { Completion } from '../providers/assistant-llm.js';
import { TelegramApiError } from '../channels/telegram-assistant-api.js';
import {
  claimPromptRequest,
  finishPromptTurn,
} from '../tasks/assistant-prompt-scheduler.js';
import {
  nextPromptRun,
  normalizePromptCron,
} from '../shared/prompt-schedule.js';
import { AssistantWorker } from './worker.js';
import { deliverMessages } from './delivery.js';
import { BudgetExceeded, reserveBudget } from './budget.js';
import { executeTool, type ToolContext } from './tools.js';
import { executePromptJobTool } from './prompt-job-tools.js';
import { syntheticApi, syntheticConfig } from './core-test-fixtures.js';

const stores: AssistantStore[] = [];
const roots: string[] = [];
function fixture(persistent = false) {
  const root = persistent
    ? mkdtempSync(path.join(tmpdir(), 'goodkiddo-prompt-'))
    : undefined;
  if (root) roots.push(root);
  const file = root ? path.join(root, 'test.db') : ':memory:';
  const store = new AssistantStore(file);
  stores.push(store);
  const config = syntheticConfig();
  const chat = {
    id: '100',
    type: 'private' as const,
    timezone: 'UTC',
    active: 1,
  };
  store.saveChat(chat);
  const analytics = new AssistantAnalytics(config, store);
  return { store, file, config, chat, analytics, api: syntheticApi() };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function input(notification: NotificationMode = 'summary'): PromptJobInput {
  return {
    title: 'synthetic report',
    prompt: 'Summarize synthetic data',
    cron: '0 8 * * *',
    timezone: 'UTC',
    notification,
    maxCalls: 2,
    maxSearches: 1,
    maxCostUsd: 0,
  };
}
function due(store: AssistantStore, options = input()) {
  const job = store.promptJobs.create('100', '101', options, 'origin-a', 20);
  store.db
    .query('UPDATE assistant_prompt_jobs SET next_run=? WHERE id=?')
    .run(new Date(Date.now() - 1000).toISOString(), job.id);
  return store.promptJobs.get(job.id)!;
}
function outbox(store: AssistantStore) {
  return store.db.query('SELECT id,text FROM assistant_outbox').all() as {
    id: string;
    text: string;
  }[];
}
const successLlm = {
  complete: async () => ({
    message: { role: 'assistant' as const, content: 'synthetic report result' },
    usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0 },
  }),
};

test('schedules have fixed minutes and confirmed IANA timezones, including DST', () => {
  expect(normalizePromptCron('@hourly')).toBe('0 * * * *');
  expect(() => normalizePromptCron('* * * * *')).toThrow();
  expect(() => normalizePromptCron('0 0 * * * *')).toThrow();
  expect(() => normalizePromptCron('0,30 * * * *')).toThrow();
  expect(() =>
    nextPromptRun('0 8 * * *', 'invalid/zone', new Date()),
  ).toThrow();
  expect(
    nextPromptRun(
      '0 9 * * *',
      'America/New_York',
      new Date('2026-03-07T15:00:00Z'),
    ),
  ).toBe('2026-03-08T13:00:00.000Z');
});
test('create/claim survive reopen and one occurrence is claimed only once', () => {
  const { store, file } = fixture(true);
  const job = due(store);
  expect(
    store.promptJobs.create('100', '101', input(), 'origin-a', 20).id,
  ).toBe(job.id);
  const claim = store.promptJobs.claim()!;
  const reopened = new AssistantStore(file);
  stores.push(reopened);
  expect(reopened.promptJobs.claim()).toBeUndefined();
  expect(reopened.promptJobs.result('100', claim.runId).status).toBe('claimed');
  expect(
    reopened.promptJobs.get(job.id)!.nextRun > new Date().toISOString(),
  ).toBe(true);
});
test('missed occurrences are skipped instead of replayed in a burst', () => {
  const { store } = fixture();
  const job = due(store, { ...input(), cron: '0 * * * *' });
  store.db
    .query('UPDATE assistant_prompt_jobs SET next_run=? WHERE id=?')
    .run('2020-01-01T00:00:00.000Z', job.id);
  expect(
    store.promptJobs.claim(new Date('2026-09-30T10:30:00Z')),
  ).toBeDefined();
  expect(store.promptJobs.get(job.id)?.nextRun).toBe(
    '2026-09-30T11:00:00.000Z',
  );
  expect(
    store.promptJobs.claim(new Date('2026-09-30T10:30:00Z')),
  ).toBeUndefined();
});
test('paused/inactive chats are not claimed and limits are validated before persistence', () => {
  const { store, chat } = fixture();
  const job = due(store);
  store.saveChat({ ...chat, active: 0 });
  expect(store.promptJobs.claim()).toBeUndefined();
  store.saveChat(chat);
  store.promptJobs.update(chat.id, '101', job.id, { status: 'paused' });
  expect(store.promptJobs.claim()).toBeUndefined();
  expect(() =>
    store.promptJobs.create(
      chat.id,
      '101',
      { ...input(), maxCalls: 7 },
      'bad-1',
      20,
    ),
  ).toThrow();
  expect(() =>
    store.promptJobs.create(
      chat.id,
      '101',
      { ...input(), maxCostUsd: 2 },
      'bad-2',
      20,
    ),
  ).toThrow();
  expect(() =>
    store.promptJobs.create(chat.id, '101', input(), 'overflow', 1),
  ).toThrow();
});
test('edit/pause/resume require owner and chat, and invalidate pending notifications', () => {
  const { store, config } = fixture();
  const job = due(store);
  const request = claimPromptRequest(store, config)!;
  store.promptJobs.startRun(request.scheduled!.runId);
  finishPromptTurn(store, request, 'saved report', 'success');
  expect(outbox(store)).toHaveLength(1);
  expect(() =>
    store.promptJobs.update('other', '101', job.id, { status: 'paused' }),
  ).toThrow();
  expect(() =>
    store.promptJobs.update('100', 'other', job.id, { status: 'paused' }),
  ).toThrow();
  const paused = store.promptJobs.update('100', '101', job.id, {
    status: 'paused',
    prompt: 'edited prompt',
    notification: 'silent',
  });
  expect(paused.revision).toBe(2);
  expect(outbox(store)).toEqual([]);
  expect(store.promptJobs.result('100', request.scheduled!.runId).result).toBe(
    'saved report',
  );
  expect(store.promptJobs.result('100', request.scheduled!.runId).status).toBe(
    'cancelled',
  );
  const resumed = store.promptJobs.update('100', '101', job.id, {
    status: 'active',
  });
  expect(resumed.prompt).toBe('edited prompt');
  expect(resumed.nextRun > new Date().toISOString()).toBe(true);
});
test('results are chat-scoped and notification modes preserve complete results', async () => {
  for (const mode of ['verbose', 'summary', 'errors_only', 'silent'] as const) {
    const { store, config, analytics, api } = fixture();
    due(store, input(mode));
    const request = claimPromptRequest(store, config)!;
    store.promptJobs.startRun(request.scheduled!.runId);
    store.startRun(request.scheduled!.runId, request.chat, '101', 'other');
    const full = 'full result '.repeat(200);
    expect(finishPromptTurn(store, request, full, 'success')).toBe(
      mode === 'verbose' || mode === 'summary',
    );
    expect(
      store.promptJobs.result('100', request.scheduled!.runId).result,
    ).toBe(full);
    expect(() =>
      store.promptJobs.result('other', request.scheduled!.runId),
    ).toThrow();
    if (mode === 'summary')
      expect(outbox(store)[0]!.text.length).toBeLessThan(650);
    if (mode === 'verbose') expect(outbox(store)[0]!.text).toContain(full);
    if (mode === 'errors_only' || mode === 'silent')
      expect(outbox(store)).toEqual([]);
    await deliverMessages(store, api, analytics);
    expect(
      store.promptJobs.result('100', request.scheduled!.runId).status,
    ).toBe('success');
    expect(finishPromptTurn(store, request, full, 'success')).toBe(false);
  }
});
test('three execution failures auto-pause; silent remains silent', () => {
  const { store, config } = fixture();
  const job = due(store, input('silent'));
  for (let i = 0; i < 3; i++) {
    store.db
      .query('UPDATE assistant_prompt_jobs SET next_run=? WHERE id=?')
      .run(
        new Date(
          Date.parse('2026-01-01T00:00:00Z') + i * 3600_000,
        ).toISOString(),
        job.id,
      );
    const request = claimPromptRequest(store, config)!;
    finishPromptTurn(store, request, 'synthetic error', 'error');
  }
  expect(store.promptJobs.get(job.id)?.status).toBe('paused');
  expect(store.promptJobs.get(job.id)?.failures).toBe(3);
  expect(outbox(store)).toEqual([]);
});
test('actual worker runs recurring prompts without creating inbox entries', async () => {
  const { store, config, analytics, api } = fixture();
  const job = due(store, input('silent'));
  const worker = new AssistantWorker(config, store, analytics, successLlm, api);
  worker.wake();
  await worker.idle();
  await worker.stop();
  expect(
    store.db.query('SELECT COUNT(*) AS n FROM assistant_inbox').get(),
  ).toEqual({ n: 0 });
  expect(store.promptJobs.runs('100', job.id)[0]?.status).toBe('success');
  expect(store.promptJobs.runs('100', job.id)[0]?.result).toBe(
    'synthetic report result',
  );
  expect(outbox(store)).toEqual([]);
});
test('foreground requests have priority over due recurring prompts in the same worker', async () => {
  const { store, config, analytics, api, chat } = fixture();
  due(store, input('silent'));
  store.enqueue({
    updateId: 1,
    chat,
    actor: { id: '101', name: 'Synthetic' },
    text: 'foreground request',
    interaction: 'message',
  });
  const seen: string[] = [];
  const llm = {
    complete: async (messages: { role: string; content: string | null }[]) => {
      seen.push(
        messages.filter((message) => message.role === 'user').at(-1)!.content!,
      );
      return successLlm.complete();
    },
  };
  const worker = new AssistantWorker(config, store, analytics, llm, api);
  worker.wake();
  await worker.idle();
  await worker.stop();
  expect(seen).toHaveLength(2);
  expect(seen[0]).toContain('foreground request');
  expect(seen[1]).toContain('Периодическое поручение');
});
test('recurring runs cannot mutate memory/tasks and stop at their own call budget', async () => {
  const { store, config, analytics, api } = fixture();
  const job = due(store, input('errors_only'));
  let calls = 0;
  const llm = {
    complete: async (
      _messages: unknown,
      tools: { function: { name: string } }[],
    ) => {
      calls++;
      expect(
        tools.some((tool) => tool.function.name === 'create_prompt_job'),
      ).toBe(false);
      return {
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'write-' + calls,
              type: 'function' as const,
              function: {
                name: 'memory_write',
                arguments: '{"key":"unsafe","content":"no"}',
              },
            },
          ],
        },
      };
    },
  };
  const worker = new AssistantWorker(config, store, analytics, llm, api);
  worker.wake();
  await worker.idle();
  await worker.stop();
  expect(calls).toBe(2);
  expect(store.memory.list('100')).toEqual([]);
  expect(store.promptJobs.list('100')).toHaveLength(1);
  expect(store.promptJobs.runs('100', job.id)[0]?.status).toBe(
    'awaiting_delivery',
  );
  await deliverMessages(store, api, analytics);
  expect(store.promptJobs.runs('100', job.id)[0]?.status).toBe('timeout');
});
test('per-run reservations and monthly limits fail atomically before new spending', () => {
  const { store, config } = fixture();
  config.monthlyBudget = 1;
  reserveBudget(store, config, 0.08, { taskId: 'synthetic', maxCostUsd: 0.1 });
  expect(() =>
    reserveBudget(store, config, 0.03, {
      taskId: 'synthetic',
      maxCostUsd: 0.1,
    }),
  ).toThrow(BudgetExceeded);
  expect(store.monthSpend()).toBeCloseTo(0.08);
  expect(() =>
    reserveBudget(store, config, 1, { taskId: 'synthetic', maxCostUsd: 10 }),
  ).toThrow(BudgetExceeded);
  expect(store.monthSpend()).toBeCloseTo(0.08);
});
test('actual scheduled LLM turn is stopped before a second call exceeds its cost cap', async () => {
  const { store, config, analytics, api } = fixture();
  config.monthlyBudget = 1;
  config.outputPrice = 1;
  const job = due(store, { ...input('errors_only'), maxCostUsd: 0.00015 });
  let calls = 0;
  const llm = {
    complete: async () => {
      calls++;
      return {
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'read',
              type: 'function' as const,
              function: { name: 'memory_list', arguments: '{}' },
            },
          ],
        },
        usage: { prompt_tokens: 0, completion_tokens: 100, cost: 0.0001 },
      };
    },
  };
  const worker = new AssistantWorker(config, store, analytics, llm, api);
  worker.wake();
  await worker.idle();
  await worker.stop();
  expect(calls).toBe(1);
  expect(store.monthSpend()).toBeCloseTo(0.0001);
  await deliverMessages(store, api, analytics);
  expect(store.promptJobs.runs('100', job.id)[0]?.status).toBe('refused');
});
test('scheduled requests share the owner daily cap and make no provider call after exhaustion', async () => {
  const { store, config, analytics, api, chat } = fixture();
  const job = due(store, input('silent'));
  for (let i = 0; i < config.dailyTasks; i++)
    store.startRun('prior-' + i, chat, '101', 'other');
  let called = false;
  const worker = new AssistantWorker(
    config,
    store,
    analytics,
    {
      complete: async () => {
        called = true;
        return successLlm.complete();
      },
    },
    api,
  );
  worker.wake();
  await worker.idle();
  await worker.stop();
  expect(called).toBe(false);
  expect(store.promptJobs.runs('100', job.id)[0]?.status).toBe('refused');
});
test('pause during an actual outstanding completion suppresses its result and notification', async () => {
  const { store, config, analytics, api } = fixture();
  const job = due(store);
  let resolve!: (value: Completion) => void;
  let started!: () => void;
  const completion = new Promise<Completion>((yes) => {
    resolve = yes;
  });
  const running = new Promise<void>((yes) => {
    started = yes;
  });
  const worker = new AssistantWorker(
    config,
    store,
    analytics,
    {
      complete: async () => {
        started();
        return completion;
      },
    },
    api,
  );
  worker.wake();
  await running;
  store.promptJobs.update('100', '101', job.id, { status: 'paused' });
  resolve(await successLlm.complete());
  await worker.idle();
  await worker.stop();
  expect(store.promptJobs.runs('100', job.id)[0]?.status).toBe('cancelled');
  expect(outbox(store)).toEqual([]);
});
test('interrupted claimed run is recovered once without replaying the provider call', async () => {
  const { store, file, config, api } = fixture(true);
  const job = due(store, input('errors_only'));
  const claimed = store.promptJobs.claim()!;
  const reopened = new AssistantStore(file);
  stores.push(reopened);
  const analytics = new AssistantAnalytics(config, reopened);
  let called = false;
  const worker = new AssistantWorker(
    config,
    reopened,
    analytics,
    {
      complete: async () => {
        called = true;
        return successLlm.complete();
      },
    },
    api,
  );
  worker.recoverInterrupted();
  worker.recoverInterrupted();
  worker.wake();
  await worker.idle();
  await worker.stop();
  expect(called).toBe(false);
  expect(outbox(reopened)).toHaveLength(1);
  await deliverMessages(reopened, api, analytics);
  expect(reopened.promptJobs.result('100', claimed.runId).status).toBe('error');
  expect(reopened.promptJobs.get(job.id)?.failures).toBe(1);
});
test('notification failure is separate from execution success and retains the full result', async () => {
  const { store, config, analytics, api } = fixture();
  const job = due(store);
  const worker = new AssistantWorker(config, store, analytics, successLlm, api);
  worker.wake();
  await worker.idle();
  await worker.stop();
  store.db.query('UPDATE assistant_outbox SET attempts=2').run();
  await deliverMessages(
    store,
    Object.assign(syntheticApi(), {
      send: async () => {
        throw new TelegramApiError(400);
      },
    }),
    analytics,
  );
  const run = store.promptJobs.runs('100', job.id)[0]!;
  expect(run.status).toBe('delivery_failed');
  expect(run.result).toBe('synthetic report result');
});
test('creation tool applies defaults compatible with zero-cost deployment and enforces global caps', () => {
  const { store, config, chat } = fixture();
  const ctx = {
    store,
    config,
    taskId: 'synthetic',
    request: { chat, actor: { id: '101' } } as InboundRequest,
  } as ToolContext;
  const created = executePromptJobTool(
    'create_prompt_job',
    JSON.stringify({
      title: 'report',
      prompt: 'synthetic',
      cron: '0 8 * * *',
      timezone: 'UTC',
    }),
    ctx,
  ) as { maxCostUsd: number };
  expect(created.maxCostUsd).toBe(0);
  expect(() =>
    executePromptJobTool(
      'create_prompt_job',
      JSON.stringify({
        title: 'bad',
        prompt: 'synthetic',
        cron: '0 8 * * *',
        timezone: 'UTC',
        maxCostUsd: 0.1,
      }),
      ctx,
    ),
  ).toThrow();
});
