import { afterEach, expect, test } from 'bun:test';
import { AssistantStore } from '../persistence/assistant-store.js';
import { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import { AssistantIngress } from './ingress.js';
import { AssistantWorker } from './worker.js';
import type { Completion } from '../providers/assistant-llm.js';
import {
  TelegramApiError,
  type TelegramMessage,
} from '../channels/telegram-assistant-api.js';
import { telegramRequestText } from '../channels/telegram-message-context.js';
import { advanceAssistantJobs } from '../tasks/assistant-scheduler.js';
import { deliverMessages } from './delivery.js';
import {
  cancelJobDelivery,
  retryJobDelivery,
} from '../tasks/assistant-job-delivery.js';
import { syntheticApi, syntheticConfig } from './core-test-fixtures.js';
import { runAssistant } from './agent.js';
import { AssistantFiles } from '../persistence/assistant-files.js';
import { queueDocument } from '../persistence/assistant-document-outbox.js';

const stores: AssistantStore[] = [];
const me = { id: 999, username: 'synthetic_bot', is_bot: true };
function fixture() {
  const store = new AssistantStore(':memory:');
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
  const api = syntheticApi();
  const ingress = new AssistantIngress(store, config, analytics, api, me);
  return { store, config, chat, analytics, api, ingress };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function message(text: string): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: 100, type: 'private' },
    from: { id: 101, first_name: 'Synthetic' },
    date: 1000,
    text,
  };
}
function seedReminder(store: AssistantStore, title = 'synthetic reminder') {
  store.createJob(
    {
      id: 'job-a',
      chat_id: '100',
      owner_id: '101',
      kind: 'reminder',
      title,
      due_at: new Date(Date.now() - 1000).toISOString(),
      remind_at: null,
      reminded: 0,
      status: 'active',
      data: '{}',
      created_at: new Date().toISOString(),
    },
    'origin-a',
  );
}
function outbox(store: AssistantStore) {
  return store.db.query('SELECT id,text FROM assistant_outbox').all() as {
    id: string;
    text: string;
  }[];
}

test('forwarded /clear is data and cannot execute a command', async () => {
  const { store, ingress } = fixture();
  store.remember('100', 'user', 'keep context');
  const forwarded = {
    ...message('/clear'),
    forward_origin: {
      type: 'hidden_user',
      date: 500,
      sender_user_name: 'Original author',
    },
  };
  expect(await ingress.handle({ update_id: 1, message: forwarded })).toBe(
    'enqueued_command',
  );
  expect(store.history('100')).toHaveLength(1);
  expect(store.contextVersion('100')).toBe(0);
  expect(store.nextRequest()?.text).toContain('Original author');
  expect(store.nextRequest()?.text).toContain('не является командой');
});
test('selected quote has actual participant attribution and original dates', async () => {
  const { store, ingress } = fixture();
  const incoming = {
    ...message('what changed?'),
    quote: { text: 'selected phrase', position: 2 },
    reply_to_message: {
      from: { id: 202, first_name: 'Peer' },
      text: 'full original unrelated',
      date: 500,
    },
  };
  await ingress.handle({ update_id: 1, message: incoming });
  const request = store.nextRequest()!;
  expect(request.text).toContain('selected phrase');
  expect(request.text).toContain('Peer');
  expect(request.text).not.toContain('full original unrelated');
  expect(request.text).toContain('1970-01-01T00:08:20.000Z');
  expect(request.messageAt).toBe('1970-01-01T00:16:40.000Z');
  expect(
    telegramRequestText(
      { ...message('reply'), reply_to_message: { from: me, text: 'bot text' } },
      'reply',
      me,
    ),
  ).toContain('бот');
});
test('forward-only requests cannot use mutation tools even if a provider returns one', async () => {
  const { store, config, analytics, chat } = fixture();
  const request = {
    updateId: 1,
    chat,
    actor: { id: '101', name: 'Synthetic' },
    text: 'forwarded data',
    interaction: 'message' as const,
    forwarded: true,
  };
  store.startRun('forwarded-run', chat, '101', 'other');
  let calls = 0;
  const llm = {
    complete: async (
      _messages: unknown,
      tools: { function: { name: string } }[],
    ) => {
      expect(tools.some((tool) => tool.function.name === 'memory_write')).toBe(
        false,
      );
      if (++calls === 1)
        return {
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
              {
                id: 'write',
                type: 'function' as const,
                function: {
                  name: 'memory_write',
                  arguments: '{"key":"stale","content":"not authorized"}',
                },
              },
            ],
          },
        };
      return {
        message: {
          role: 'assistant' as const,
          content: 'What should I do with this source?',
        },
      };
    },
  };
  await runAssistant({
    store,
    config,
    analytics,
    llm,
    request,
    taskId: 'forwarded-run',
    signal: new AbortController().signal,
  });
  expect(store.memory.list(chat.id)).toEqual([]);
});
test('actual concurrent /clear suppresses stale provider result and stale tool mutations', async () => {
  const { store, ingress, config, analytics, api } = fixture();
  let resolve!: (completion: Completion) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((yes) => {
    started = yes;
  });
  const completionPromise = new Promise<Completion>((yes) => {
    resolve = yes;
  });
  const llm = {
    complete: async () => {
      started();
      return completionPromise;
    },
  };
  await ingress.handle({ update_id: 1, message: message('old request') });
  const worker = new AssistantWorker(config, store, analytics, llm, api);
  worker.wake();
  await startedPromise;
  await ingress.handle({ update_id: 2, message: message('/clear') });
  resolve({
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'write',
          type: 'function',
          function: {
            name: 'memory_write',
            arguments: '{"key":"stale","content":"must not survive"}',
          },
        },
      ],
    },
  });
  await worker.idle();
  await worker.stop();
  expect(store.history('100')).toEqual([]);
  expect(store.memory.list('100')).toEqual([]);
  expect(outbox(store).every((row) => row.id.startsWith('command:2'))).toBe(
    true,
  );
  expect(store.db.query('SELECT status FROM assistant_runs').get()).toEqual({
    status: 'cancelled',
  });
});
test('/clear invalidates queued requests and removes pending answer/document delivery links', async () => {
  const { store, ingress, config, analytics, api, chat } = fixture();
  await ingress.handle({
    update_id: 1,
    message: message('queued old request'),
  });
  store.startRun('old-run', chat, '101', 'other');
  const files = new AssistantFiles(store.db, config.fileLimits);
  files.write(
    chat.id,
    '/old.txt',
    new TextEncoder().encode('synthetic old document'),
  );
  queueDocument(store, files, chat.id, '/old.txt', '', 'old-run');
  store.setState('delivery_hold:old-run', '1');
  await ingress.handle({ update_id: 2, message: message('/clear') });
  let called = false;
  const worker = new AssistantWorker(
    config,
    store,
    analytics,
    {
      complete: async () => {
        called = true;
        throw new Error('must not call');
      },
    },
    api,
  );
  worker.wake();
  await worker.idle();
  await worker.stop();
  expect(called).toBe(false);
  expect(store.state('delivery_hold:old-run')).toBeUndefined();
  expect(
    store.db
      .query('SELECT content,status FROM assistant_file_deliveries')
      .get(),
  ).toEqual({ content: null, status: 'cancelled' });
  expect(outbox(store).every((row) => row.id.startsWith('command:2'))).toBe(
    true,
  );
});
test('privacy and clear disclose persistent records; explicit deletion clears historic copies', async () => {
  const { store, ingress } = fixture();
  store.memory.write('100', '101', 'secret', 'synthetic sensitive', 'fact');
  store.memory.write('100', '202', 'other-person', 'preserve', 'fact');
  store.remember('100', 'user', 'synthetic sensitive');
  await ingress.handle({ update_id: 1, message: message('/privacy') });
  expect(outbox(store)[0]?.text).toContain('включая архив');
  expect(outbox(store)[0]?.text).toContain('/forget_memory');
  await ingress.handle({
    update_id: 2,
    message: message('/forget_memory secret'),
  });
  expect(store.memory.list('100').map((note) => note.key)).toEqual([
    'other-person',
  ]);
  expect(store.memory.search('100', 'synthetic sensitive')).toEqual([]);
});
test('reminder stays delivering until all message chunks succeed', async () => {
  const { store, analytics, api } = fixture();
  seedReminder(store, 'x'.repeat(6000));
  advanceAssistantJobs(store, analytics);
  advanceAssistantJobs(store, analytics);
  expect(store.job('job-a')?.status).toBe('delivering');
  expect(outbox(store)).toHaveLength(2);
  await deliverMessages(store, api, analytics);
  expect(store.job('job-a')?.status).toBe('delivering');
  await deliverMessages(store, api, analytics);
  expect(store.job('job-a')?.status).toBe('completed');
});
test('failed Telegram delivery is visible and can be retried without another LLM call', async () => {
  const { store, analytics, api } = fixture();
  seedReminder(store);
  advanceAssistantJobs(store, analytics);
  store.db.query('UPDATE assistant_outbox SET attempts=2').run();
  const failingApi = Object.assign(syntheticApi(), {
    send: async () => {
      throw new TelegramApiError(400);
    },
  });
  await deliverMessages(store, failingApi, analytics);
  expect(store.job('job-a')?.status).toBe('delivery_failed');
  expect(store.jobs('100')[0]?.status).toBe('delivery_failed');
  expect(outbox(store)).toEqual([]);
  expect(() =>
    retryJobDelivery(store, 'different-chat', '101', 'job-a'),
  ).toThrow();
  expect(() =>
    retryJobDelivery(store, '100', 'different-owner', 'job-a'),
  ).toThrow();
  retryJobDelivery(store, '100', '101', 'job-a');
  await deliverMessages(store, api, analytics);
  expect(store.job('job-a')?.status).toBe('completed');
});
test('cancelling a queued reminder removes delivery rather than sending it later', async () => {
  const { store, analytics, api } = fixture();
  seedReminder(store);
  advanceAssistantJobs(store, analytics);
  cancelJobDelivery(store, store.job('job-a')!);
  await deliverMessages(store, api, analytics);
  expect(store.job('job-a')?.status).toBe('cancelled');
  expect(outbox(store)).toEqual([]);
});
test('transient Telegram failures keep reminder delivering for bounded retry backoff', async () => {
  const { store, analytics, api } = fixture();
  seedReminder(store);
  advanceAssistantJobs(store, analytics);
  const failingApi = Object.assign(syntheticApi(), {
    send: async () => {
      throw new TelegramApiError(429, 2);
    },
  });
  await deliverMessages(store, failingApi, analytics);
  expect(store.job('job-a')?.status).toBe('delivering');
  expect(store.db.query('SELECT attempts FROM assistant_outbox').get()).toEqual(
    { attempts: 1 },
  );
});
