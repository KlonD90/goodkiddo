import { afterEach, expect, test } from 'bun:test';
import {
  AssistantAnalytics,
  type AnalyticsClient,
} from '../../src/integrations/assistant-analytics.js';
import {
  analyticsProperties,
  startSource,
} from '../../src/integrations/assistant-analytics-policy.js';
import { AssistantStore } from '../../src/persistence/assistant-store.js';
import {
  syntheticApi,
  syntheticConfig,
} from '../../src/assistant/core-test-fixtures.js';
import { AssistantIngress } from '../../src/assistant/ingress.js';
import { AssistantWorker } from '../../src/assistant/worker.js';
import { deliverMessages } from '../../src/assistant/delivery.js';

const stores: AssistantStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const config = {
    ...syntheticConfig(),
    posthogKey: 'synthetic-project',
    analyticsSalt: 'synthetic-salt',
    analyticsTestMode: true,
  };
  const store = new AssistantStore(':memory:');
  stores.push(store);
  const chat = {
    id: '100',
    type: 'private' as const,
    timezone: 'UTC',
    active: 1,
  };
  store.saveChat(chat);
  const captures: any[] = [];
  let failed = false;
  const client: AnalyticsClient = {
    capture: (event) => {
      captures.push(event);
    },
    flush: async () => {
      if (failed) throw new Error('synthetic-private-error');
    },
    shutdown: async () => {},
  };
  const analytics = new AssistantAnalytics(config, store, () => client);
  const ingress = new AssistantIngress(
    store,
    config,
    analytics,
    syntheticApi(),
    { id: 999, username: 'synthetic_bot', is_bot: true },
  );
  const message = (text: string, updateId = 1) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1000,
      chat: { id: 100, type: 'private' as const },
      from: {
        id: 101,
        first_name: 'private-name',
        username: 'private_username',
      },
      text,
    },
  });
  const events = () =>
    (
      store.db.query('SELECT payload FROM assistant_events').all() as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload));
  return {
    config,
    store,
    chat,
    client,
    analytics,
    captures,
    ingress,
    message,
    events,
    fail: () => {
      failed = true;
    },
  };
}

test('property values and start attribution reject private or arbitrary input', () => {
  expect(startSource('landing_hero')).toBe('landing_hero');
  expect(startSource('private-token')).toBe('unknown');
  expect(startSource(undefined)).toBe('direct');
  expect(
    analyticsProperties({
      message: 'secret',
      error_type: 'stack-secret',
      source: 'https://example.com?token=secret',
      model: 'https://model.invalid?token=secret',
      provider: 'https://provider.invalid/token',
      tokens_in: -1,
      tokens_out: Infinity,
      status: 'success',
      tool_name: 'private-file.txt',
    }),
  ).toEqual({ status: 'success' });
});

test('stable pseudonyms, task IDs, event deduplication, test marker and event time', () => {
  const s = fixture();
  s.analytics.track('private-token', 'bot_interaction', s.chat, '101', {
    interaction_type: 'message',
    text: 'secret',
  });
  s.analytics.track('private-token', 'bot_interaction', s.chat, '101');
  s.analytics.start('private-job-title', s.chat, '101', 'other', 'user');
  const events = s.events();
  expect(events).toHaveLength(2);
  expect(events[0].distinctId).toMatch(/^u_[a-f0-9]{16}$/);
  expect(events[0].distinctId).toBe(events[1].distinctId);
  expect(events[0].properties.chat_id).toMatch(/^c_[a-f0-9]{16}$/);
  expect(events[1].properties.task_id).toMatch(/^t_[a-f0-9]{16}$/);
  expect(events[0].properties.is_test).toBe(true);
  expect(events[0].properties.$process_person_profile).toBe(false);
  expect(events[0].properties.$geoip_disable).toBe(true);
  expect(Date.parse(events[0].timestamp)).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toMatch(
    /private-token|private-job-title|secret|private_username/,
  );
  s.analytics.track('bad-event', 'secret' as any, s.chat, '101');
  expect(s.events()).toHaveLength(2);
});

test('accepted requests exclude commands, repeated updates dedupe, starts only keep allowed sources', async () => {
  const s = fixture();
  await s.ingress.handle(s.message('/start landing_hero'));
  await s.ingress.handle(s.message('/start secret-token', 2));
  await s.ingress.handle(s.message('secret request', 3));
  await s.ingress.handle(s.message('secret request', 3));
  expect(
    s
      .events()
      .filter((e) => e.event === 'bot_started')
      .map((e) => e.properties.source),
  ).toEqual(['landing_hero', 'unknown']);
  expect(s.events().filter((e) => e.event === 'request_accepted')).toHaveLength(
    1,
  );
  expect(JSON.stringify(s.events())).not.toMatch(
    /secret|private-name|private_username/,
  );
});

test('failed uploads keep durable events and preserve timestamps on retry', async () => {
  const s = fixture();
  s.analytics.track('event', 'bot_interaction', s.chat, '101');
  const timestamp = s.events()[0].timestamp;
  s.fail();
  await expect(s.analytics.flush()).rejects.toThrow();
  expect(s.events()).toHaveLength(1);
  expect(s.captures[0].timestamp.toISOString()).toBe(timestamp);
});

test('analytics storage or constructor failure cannot break acceptance, generation or delivery', async () => {
  const s = fixture();
  s.store.db.run('DROP TABLE assistant_events');
  const sent: string[] = [];
  const api = {
    ...syntheticApi(),
    send: async (_chat: string, text: string) => {
      sent.push(text);
    },
  } as any;
  await expect(s.ingress.handle(s.message('secret request'))).resolves.toBe(
    'enqueued_message',
  );
  const worker = new AssistantWorker(
    s.config,
    s.store,
    s.analytics,
    {
      complete: async () => ({
        message: { role: 'assistant' as const, content: 'Delivered' },
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    },
    api,
  );
  worker.wake();
  await worker.idle();
  await deliverMessages(s.store, api, s.analytics);
  expect(sent).toContain('Delivered');
  expect(
    (
      s.store.db.query('SELECT status FROM assistant_runs').get() as {
        status: string;
      }
    ).status,
  ).toBe('success');
  expect(
    () =>
      new AssistantAnalytics(s.config, s.store, () => {
        throw new Error('private-key');
      }),
  ).not.toThrow();
});

test('task completion is emitted once with bounded duration and aggregate usage', () => {
  const s = fixture();
  s.analytics.start('task', s.chat, '101', 'other', 'user');
  s.store.addUsage('task', {
    llm_calls: 2,
    tokens_in: 10,
    tokens_out: 5,
    cost_usd: 0.1,
  });
  s.analytics.finish('task', s.chat, '101', 'error', 'llm_error');
  s.analytics.finish('task', s.chat, '101', 'success');
  const events = s.events().filter((e) => e.event === 'task_completed');
  expect(events).toHaveLength(1);
  expect(events[0].properties).toMatchObject({
    status: 'error',
    llm_calls: 2,
    tokens_in: 10,
    tokens_out: 5,
    cost_usd: 0.1,
  });
  expect(events[0].properties.duration_sec).toBeGreaterThanOrEqual(0);
});

test('stalled analytics flush is single-flight and does not block the next bot delivery', async () => {
  const s = fixture();
  let release!: () => void;
  s.client.flush = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  s.analytics.track('event', 'bot_interaction', s.chat, '101');
  const flushing = s.analytics.flush();
  expect(s.analytics.flush()).toBe(flushing);
  const sent: string[] = [];
  const api = {
    ...syntheticApi(),
    send: async (_chat: string, text: string) => {
      sent.push(text);
    },
  } as any;
  await s.ingress.handle(s.message('request'));
  const worker = new AssistantWorker(
    s.config,
    s.store,
    s.analytics,
    {
      complete: async () => ({
        message: { role: 'assistant' as const, content: 'Delivered' },
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    },
    api,
  );
  worker.wake();
  await worker.idle();
  await deliverMessages(s.store, api, s.analytics);
  expect(sent).toContain('Delivered');
  release();
  await flushing;
  expect(s.events().some((e) => e.event === 'task_completed')).toBe(true);
});

test('model and tool usage capture only aggregate outcomes and registered tool names', async () => {
  const s = fixture();
  await s.ingress.handle(s.message('secret request'));
  let calls = 0;
  const worker = new AssistantWorker(
    s.config,
    s.store,
    s.analytics,
    {
      complete: async () => ({
        message:
          ++calls === 1
            ? {
                role: 'assistant' as const,
                content: null,
                tool_calls: [
                  {
                    id: 'private-call-id',
                    type: 'function' as const,
                    function: { name: 'memory_list', arguments: '{}' },
                  },
                  {
                    id: 'private-call-id-2',
                    type: 'function' as const,
                    function: {
                      name: 'private-file.txt',
                      arguments: '{"token":"secret"}',
                    },
                  },
                ],
              }
            : { role: 'assistant' as const, content: 'Delivered' },
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    },
    syntheticApi(),
  );
  worker.wake();
  await worker.idle();
  const tools = s.events().filter((e) => e.event === 'tool_usage');
  expect(
    tools.map((e) => [e.properties.tool_name, e.properties.status]),
  ).toEqual([
    ['memory_list', 'success'],
    ['unknown', 'error'],
  ]);
  expect(s.events().filter((e) => e.event === 'llm_usage')).toHaveLength(2);
  expect(JSON.stringify(s.events())).not.toMatch(
    /secret|private-call-id|private-file/,
  );
});
