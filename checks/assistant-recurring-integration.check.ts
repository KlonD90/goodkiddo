import { afterEach, expect, test } from 'bun:test';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.ts';
import { AssistantWorker } from '../src/assistant/worker.ts';
import { deliverMessages } from '../src/assistant/delivery.ts';
import { deliveryStatus } from '../src/assistant/delivery-status.ts';
import { retryDelivery } from '../src/persistence/assistant-delivery-retry.ts';
import { clearChatContext } from '../src/assistant/context.ts';
import { expireDeliverySnapshots } from '../src/persistence/assistant-delivery-ledger.ts';
import {
  TelegramApiError,
  type TelegramAssistantApi,
} from '../src/channels/telegram-assistant-api.ts';
import type { AssistantLlm } from '../src/providers/assistant-llm.ts';
import type { NotificationMode } from '../src/shared/assistant-types.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';

const stores: AssistantStore[] = [];
function setup(mode: NotificationMode = 'verbose', result = 'x'.repeat(6000)) {
  const store = new AssistantStore(':memory:'),
    config = fileConfig(),
    analytics = new AssistantAnalytics(config, store),
    calls: string[] = [];
  stores.push(store);
  store.saveChat({ id: '1', type: 'private', timezone: 'UTC', active: 1 });
  const job = store.promptJobs.create(
    '1',
    '1',
    {
      title: 'Synthetic recurring',
      prompt: 'Read a synthetic report',
      cron: '@hourly',
      timezone: 'UTC',
      notification: mode,
      maxCalls: 1,
      maxSearches: 0,
      maxCostUsd: 0,
    },
    'synthetic-' + mode,
    20,
  );
  store.db
    .query(
      "UPDATE assistant_prompt_jobs SET next_run='2000-01-01T00:00:00Z' WHERE id=?",
    )
    .run(job.id);
  const api = {
    typing: async () => {
      calls.push('typing');
    },
    call: async (method: string) => {
      calls.push(method);
      return { message_id: 123 };
    },
    send: async () => 123,
  } as unknown as TelegramAssistantApi;
  let modelCalls = 0;
  const llm: AssistantLlm = {
    complete: async (_messages, tools, _signal, onContent) => {
      modelCalls++;
      expect(onContent).toBeUndefined();
      expect(tools.map((t) => t.function.name)).not.toContain('send_file');
      expect(tools.map((t) => t.function.name)).not.toContain(
        'grant_fs_access',
      );
      expect(tools.map((t) => t.function.name)).toContain('read_file');
      return {
        message: { role: 'assistant', content: result },
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      };
    },
  };
  const worker = new AssistantWorker(config, store, analytics, llm, api);
  return {
    store,
    config,
    analytics,
    api,
    worker,
    calls,
    job,
    modelCalls: () => modelCalls,
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
for (const mode of ['silent', 'errors_only', 'summary'] as const) {
  test(`scheduled ${mode} never leaks a private draft or group preview before notification policy`, async () => {
    const s = setup(mode, 'a'.repeat(1000) + 'PRIVATE_TAIL');
    try {
      s.worker.wake();
      await s.worker.idle();
      expect(s.calls).toEqual([]);
      expect(s.modelCalls()).toBe(1);
      const run = s.store.promptJobs.runs('1', s.job.id)[0];
      expect(run.result).toContain('PRIVATE_TAIL');
      expect(s.store.history('1')).toEqual([]);
      const outbox = s.store.db
        .query('SELECT text FROM assistant_outbox')
        .all() as { text: string }[];
      if (mode === 'summary') {
        expect(outbox).toHaveLength(1);
        expect(outbox[0].text).not.toContain('PRIVATE_TAIL');
        expect(s.store.state(`delivery_hold:${run.id}`)).toBeUndefined();
        await deliverMessages(s.store, s.api, s.analytics);
        expect(s.store.promptJobs.result('1', run.id).status).toBe('success');
      } else expect(outbox).toHaveLength(0);
    } finally {
      await s.worker.stop();
    }
  });
}
test('recurring ambiguous notification retry restores remaining chunks without another model call', async () => {
  const s = setup();
  try {
    s.worker.wake();
    await s.worker.idle();
    const run = s.store.promptJobs.runs('1', s.job.id)[0];
    let sends = 0;
    s.api.send = async () => {
      if (++sends === 2) throw new TelegramApiError(0);
      return 123;
    };
    await deliverMessages(s.store, s.api, s.analytics);
    await deliverMessages(s.store, s.api, s.analytics);
    expect(s.store.promptJobs.result('1', run.id).status).toBe(
      'delivery_failed',
    );
    const batch = deliveryStatus(s.store, '1')[0].id;
    expect(() => retryDelivery(s.store, '1', '1', batch)).toThrow('дубликат');
    retryDelivery(s.store, '1', '1', batch, true);
    s.api.send = async () => {
      sends++;
      return 123;
    };
    await deliverMessages(s.store, s.api, s.analytics);
    expect(sends).toBe(3);
    expect(s.modelCalls()).toBe(1);
    expect(s.store.promptJobs.result('1', run.id).status).toBe('success');
  } finally {
    await s.worker.stop();
  }
});
test('pausing a failed recurring job revokes explicit retry of its old notification', async () => {
  const s = setup();
  try {
    s.worker.wake();
    await s.worker.idle();
    s.api.send = async () => {
      throw new TelegramApiError(0);
    };
    await deliverMessages(s.store, s.api, s.analytics);
    const batch = deliveryStatus(s.store, '1')[0].id;
    s.store.promptJobs.update('1', '1', s.job.id, { status: 'paused' });
    expect(() => retryDelivery(s.store, '1', '1', batch, true)).toThrow(
      'приостановлено',
    );
    expect(
      s.store.db.query('SELECT id FROM assistant_outbox').all(),
    ).toHaveLength(0);
  } finally {
    await s.worker.stop();
  }
});
test('clear or expiry reconciles queued recurring notification status while preserving job and full result', async () => {
  for (const expiry of [false, true]) {
    const s = setup();
    try {
      s.worker.wake();
      await s.worker.idle();
      const run = s.store.promptJobs.runs('1', s.job.id)[0];
      if (expiry) {
        const batch = deliveryStatus(s.store, '1')[0];
        expireDeliverySnapshots(s.store, Date.parse(batch.expires_at) + 1);
      } else clearChatContext(s.store, '1');
      expect(s.store.promptJobs.result('1', run.id).status).toBe(
        expiry ? 'delivery_failed' : 'cancelled',
      );
      expect(s.store.promptJobs.result('1', run.id).result).toHaveLength(6000);
      expect(s.store.promptJobs.get(s.job.id)?.status).toBe('active');
      expect(
        s.store.db.query('SELECT id FROM assistant_outbox').all(),
      ).toHaveLength(0);
    } finally {
      await s.worker.stop();
    }
  }
});
