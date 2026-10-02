import { test, expect } from 'bun:test';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantFiles } from '../src/persistence/assistant-files.ts';
import {
  queueDocument,
  documentDelivery,
} from '../src/persistence/assistant-document-outbox.ts';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.ts';
import { AssistantIngress } from '../src/assistant/ingress.ts';
import { AssistantWorker } from '../src/assistant/worker.ts';
import { deliverMessages } from '../src/assistant/delivery.ts';
import { fileLinkHandler } from '../src/server/assistant-file-links.ts';
import type { TelegramAssistantApi } from '../src/channels/telegram-assistant-api.ts';
import type {
  AssistantLlm,
  Completion,
} from '../src/providers/assistant-llm.ts';
import type { LlmMessage } from '../src/shared/assistant-types.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';

function call(name: string, args: Record<string, unknown>, id: string) {
  return {
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Synthetic worker did not finish');
}

test('full synthetic model turn writes, reads, queues file and issues explicit link before final task delivery', async () => {
  const config = fileConfig();
  config.fileShares.enabled = true;
  const store = new AssistantStore(':memory:'),
    analytics = new AssistantAnalytics(config, store),
    sent: { kind: string; chat: string; text: string }[] = [];
  const api = {
    typing: async () => {},
    send: async (chat: string, text: string) => {
      sent.push({ kind: 'text', chat, text });
    },
    sendDocument: async (
      chat: string,
      file: { content: Uint8Array },
      caption: string,
    ) => {
      sent.push({
        kind: 'document',
        chat,
        text: new TextDecoder().decode(file.content) + caption,
      });
    },
  } as unknown as TelegramAssistantApi;
  const foreignBytes = 'OTHER_CHAT_PRIVATE_CONTENT';
  new AssistantFiles(store.db).write(
    '-2',
    '/report.csv',
    new TextEncoder().encode(foreignBytes),
  );
  let round = 0,
    link = '';
  const llm: AssistantLlm = {
    complete: async (messages, tools) => {
      round++;
      expect(tools.map((tool) => tool.function.name)).toContain('send_file');
      expect(tools.map((tool) => tool.function.name)).toContain('memory_write');
      expect(tools.map((tool) => tool.function.name)).toContain('todo_add');
      if (round === 1)
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              call(
                'write_file',
                {
                  file_path: '/report.csv',
                  content: 'name,value\nsynthetic,42',
                },
                'write',
              ),
              call(
                'memory_write',
                { key: 'format', content: 'CSV reports', kind: 'preference' },
                'memory',
              ),
              call('todo_add', { title: 'Review synthetic report' }, 'todo'),
            ],
          },
        };
      if (round === 2)
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              call('read_file', { file_path: '/report.csv' }, 'read'),
              call(
                'send_file',
                { file_path: '/report.csv', caption: 'Synthetic report' },
                'send',
              ),
              call(
                'grant_fs_access',
                { file_paths: ['/report.csv'], ttl_hours: 1 },
                'grant',
              ),
            ],
          },
        };
      const grant = messages.find(
        (message) =>
          message.role === 'tool' && message.tool_call_id === 'grant',
      )!;
      link = (JSON.parse(grant.content!) as { url: string }).url;
      expect(link).toContain('/fs/?uuid=');
      // A maintenance tick during the model turn must not send or finish it early.
      await deliverMessages(store, api, analytics);
      expect(sent.length).toBe(0);
      return {
        message: {
          role: 'assistant',
          content: `Файл поставлен в очередь. Ссылка ${link}`,
        },
      };
    },
  };
  const ingress = new AssistantIngress(store, config, analytics, api, {
      id: 99,
      username: 'goodkiddo_bot',
    }),
    worker = new AssistantWorker(config, store, analytics, llm, api);
  try {
    expect(
      await ingress.handle({
        update_id: 101,
        message: {
          message_id: 1,
          date: 1700000000,
          from: { id: 1, first_name: 'Synthetic' },
          chat: { id: 1, type: 'private' },
          text: 'Создай файл report.csv, отправь документ и дай ссылку для скачивания файла',
        },
      }),
    ).toBe('enqueued_message');
    worker.wake();
    await until(
      () =>
        !store.db
          .query("SELECT id FROM assistant_inbox WHERE status!='done'")
          .get(),
    );
    expect(round).toBe(3);
    expect(store.memory.list('1')[0].content).toBe('CSV reports');
    expect(store.todos.list('1')[0].title).toBe('Review synthetic report');
    expect(
      store.db
        .query(
          "SELECT key FROM assistant_state WHERE key LIKE 'delivery_hold:%'",
        )
        .all(),
    ).toEqual([]);
    expect(
      (
        store.db.query('SELECT status FROM assistant_runs').get() as {
          status: string;
        }
      ).status,
    ).toBe('running');
    await deliverMessages(store, api, analytics);
    expect(sent[0]).toMatchObject({ kind: 'document', chat: '1' });
    expect(sent[0].text).toBe('name,value\nsynthetic,42Synthetic report');
    expect(JSON.stringify(sent)).not.toContain(foreignBytes);
    await deliverMessages(store, api, analytics);
    expect(sent[1]).toMatchObject({ kind: 'text', chat: '1' });
    expect(sent[1].text).toContain(link);
    expect(
      (
        store.db.query('SELECT status FROM assistant_runs').get() as {
          status: string;
        }
      ).status,
    ).toBe('success');
    const handler = fileLinkHandler(store);
    const html = await handler(new Request(link)).text();
    expect(html).toContain('report.csv');
    expect(html).not.toContain(foreignBytes);
    const downloadPath = html.match(
      /href="(\/fs\/[A-Za-z0-9_-]{43}\/0\/report\.csv)"/,
    )![1];
    const downloadUrl = new URL(downloadPath, link);
    // A caller cannot change a bearer grant's source chat with query parameters.
    downloadUrl.searchParams.set('chat_id', '-2');
    const download = handler(new Request(downloadUrl.toString()));
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toContain('attachment');
    expect(await download.text()).toBe('name,value\nsynthetic,42');
    expect(
      new TextDecoder().decode(
        new AssistantFiles(store.db).get('-2', '/report.csv').content,
      ),
    ).toBe(foreignBytes);
  } finally {
    await worker.stop();
    store.close();
  }
});
test('interrupted turn releases its hold, preserves document and records cancellation instead of false success', async () => {
  const config = fileConfig(),
    store = new AssistantStore(':memory:'),
    analytics = new AssistantAnalytics(config, store);
  const sent: string[] = [];
  const api = {
    send: async (_chat: string, text: string) => {
      sent.push(text);
    },
    sendDocument: async (_chat: string, file: { content: Uint8Array }) => {
      sent.push(new TextDecoder().decode(file.content));
    },
  } as unknown as TelegramAssistantApi;
  const llm = {
    complete: async () => {
      throw new Error('not called');
    },
  } as AssistantLlm;
  const worker = new AssistantWorker(config, store, analytics, llm, api);
  try {
    const chat = {
      id: '1',
      type: 'private' as const,
      timezone: 'UTC',
      active: 1,
    };
    store.saveChat(chat);
    analytics.start('interrupted', chat, '1', 'other', 'user');
    store.setState('delivery_hold:interrupted', '1');
    const files = new AssistantFiles(store.db);
    files.write(
      '1',
      '/report.txt',
      new TextEncoder().encode('durable artifact'),
    );
    const delivery = queueDocument(
      store,
      files,
      '1',
      '/report.txt',
      '',
      'interrupted',
    );
    store.enqueue({
      updateId: 102,
      chat,
      actor: { id: '1', name: 'Synthetic' },
      text: 'send file',
      interaction: 'message',
    });
    store.requestStatus(102, 'processing');
    worker.recoverInterrupted();
    expect(store.state('delivery_hold:interrupted')).toBeUndefined();
    expect(
      (
        store.db.query('SELECT status FROM assistant_runs').get() as {
          status: string;
        }
      ).status,
    ).toBe('cancelled');
    expect(documentDelivery(store, delivery.id, '1')?.status).toBe('pending');
    await deliverMessages(store, api, analytics);
    await deliverMessages(store, api, analytics);
    expect(sent[0]).toBe('durable artifact');
    expect(sent[1]).toContain('прервалась');
    expect(
      (
        store.db.query('SELECT status FROM assistant_runs').get() as {
          status: string;
        }
      ).status,
    ).toBe('cancelled');
    expect(documentDelivery(store, delivery.id, '1')?.status).toBe('sent');
    worker.recoverInterrupted();
    expect(store.db.query('SELECT * FROM assistant_outbox').all()).toEqual([]);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('clear after a real document is queued cancels its bytes and blocks stale file/link tools', async () => {
  const config = fileConfig();
  config.fileShares.enabled = true;
  const store = new AssistantStore(':memory:'),
    analytics = new AssistantAnalytics(config, store);
  const sent: string[] = [];
  const api = {
    typing: async () => {},
    send: async (_chat: string, text: string) => {
      sent.push(text);
    },
    sendDocument: async () => {
      throw new Error('Cancelled document must not send');
    },
  } as unknown as TelegramAssistantApi;
  let round = 0,
    start!: () => void,
    finish!: (value: Completion) => void;
  const started = new Promise<void>((resolve) => {
      start = resolve;
    }),
    completion = new Promise<Completion>((resolve) => {
      finish = resolve;
    });
  const llm: AssistantLlm = {
    complete: async () => {
      if (++round === 1)
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              call(
                'write_file',
                { file_path: '/report.txt', content: 'retained file' },
                'write',
              ),
              call('send_file', { file_path: '/report.txt' }, 'send'),
            ],
          },
        };
      start();
      return completion;
    },
  };
  const ingress = new AssistantIngress(store, config, analytics, api, {
      id: 99,
      username: 'goodkiddo_bot',
    }),
    worker = new AssistantWorker(config, store, analytics, llm, api);
  try {
    await ingress.handle({
      update_id: 201,
      message: {
        message_id: 1,
        from: { id: 1 },
        chat: { id: 1, type: 'private' },
        text: 'Создай файл report.txt, отправь и дай ссылку на файл',
      },
    });
    worker.wake();
    await started;
    expect(
      store.db
        .query(
          "SELECT id FROM assistant_file_deliveries WHERE status='pending'",
        )
        .all().length,
    ).toBe(1);
    await ingress.handle({
      update_id: 202,
      message: {
        message_id: 2,
        from: { id: 1 },
        chat: { id: 1, type: 'private' },
        text: '/clear',
      },
    });
    finish({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          call(
            'write_file',
            { file_path: '/stale.txt', content: 'must not be written' },
            'stale',
          ),
          call('grant_fs_access', { file_paths: ['/report.txt'] }, 'link'),
        ],
      },
    });
    await worker.idle();
    expect(
      store.db
        .query('SELECT content,status FROM assistant_file_deliveries')
        .get(),
    ).toEqual({ content: null, status: 'cancelled' });
    expect(
      new AssistantFiles(store.db).list('1').map((file) => file.path),
    ).toEqual(['/report.txt']);
    expect(store.db.query('SELECT * FROM assistant_file_grants').all()).toEqual(
      [],
    );
    expect(store.history('1')).toEqual([]);
    expect(
      store.db
        .query(
          "SELECT key FROM assistant_state WHERE key LIKE 'delivery_hold:%'",
        )
        .all(),
    ).toEqual([]);
    await deliverMessages(store, api, analytics);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('очищены');
  } finally {
    await worker.stop();
    store.close();
  }
});

test('clear on another chat invalidates a document selected before an earlier HTTP send resolved', async () => {
  const config = fileConfig(),
    store = new AssistantStore(':memory:'),
    analytics = new AssistantAnalytics(config, store),
    sent: string[] = [];
  let start!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
      start = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
  const api = {
    send: async (chat: string) => {
      sent.push(chat);
      start();
      await hold;
    },
    sendDocument: async (chat: string) => {
      sent.push(chat);
    },
  } as unknown as TelegramAssistantApi;
  const ingress = new AssistantIngress(store, config, analytics, api, {
    id: 99,
    username: 'goodkiddo_bot',
  });
  try {
    store.saveChat({ id: '1', type: 'private', timezone: 'UTC', active: 1 });
    store.saveChat({ id: '2', type: 'private', timezone: 'UTC', active: 1 });
    store.send('earlier', '1', 'synthetic');
    const files = new AssistantFiles(store.db);
    files.write('2', '/report.txt', new TextEncoder().encode('synthetic'));
    store.startRun('other-run', store.chat('2')!, '2', 'other');
    queueDocument(store, files, '2', '/report.txt', '', 'other-run');
    const delivery = deliverMessages(store, api, analytics);
    await started;
    await ingress.handle({
      update_id: 301,
      message: {
        message_id: 1,
        from: { id: 2 },
        chat: { id: 2, type: 'private' },
        text: '/clear',
      },
    });
    finish();
    await delivery;
    expect(sent).toEqual(['1']);
    expect(
      store.db
        .query('SELECT content,status FROM assistant_file_deliveries')
        .get(),
    ).toEqual({ content: null, status: 'cancelled' });
  } finally {
    store.close();
  }
});

test('clear suppresses delayed visible stream callbacks as well as the final reply', async () => {
  const config = fileConfig(),
    store = new AssistantStore(':memory:'),
    analytics = new AssistantAnalytics(config, store),
    calls: string[] = [];
  let started!: () => void, finish!: () => void;
  const progress = new Promise<void>((resolve) => {
      started = resolve;
    }),
    wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
  const api = {
    typing: async () => {},
    call: async (method: string) => {
      calls.push(method);
      return { message_id: 777 };
    },
  } as unknown as TelegramAssistantApi;
  const llm: AssistantLlm = {
    complete: async (_messages, _tools, _signal, onContent) => {
      onContent!('Synthetic early draft');
      started();
      await wait;
      onContent!('Stale draft must not be displayed');
      return { message: { role: 'assistant', content: 'Stale final' } };
    },
  };
  const ingress = new AssistantIngress(store, config, analytics, api, {
      id: 99,
      username: 'goodkiddo_bot',
    }),
    worker = new AssistantWorker(config, store, analytics, llm, api);
  try {
    await ingress.handle({
      update_id: 401,
      message: {
        message_id: 1,
        from: { id: 1 },
        chat: { id: 1, type: 'private' },
        text: 'Synthetic old request',
      },
    });
    worker.wake();
    await progress;
    await ingress.handle({
      update_id: 402,
      message: {
        message_id: 2,
        from: { id: 1 },
        chat: { id: 1, type: 'private' },
        text: '/clear',
      },
    });
    const before = calls.length;
    finish();
    await worker.idle();
    expect(calls.length).toBe(before);
    expect(store.history('1')).toEqual([]);
    expect(store.db.query('SELECT status FROM assistant_runs').get()).toEqual({
      status: 'cancelled',
    });
    expect(
      (
        store.db.query('SELECT id FROM assistant_outbox').all() as {
          id: string;
        }[]
      ).every((row) => row.id.startsWith('command:402')),
    ).toBe(true);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('clear while closing an in-flight group preview prevents a stale final from refilling history', async () => {
  const config = fileConfig(),
    store = new AssistantStore(':memory:'),
    analytics = new AssistantAnalytics(config, store);
  let started!: () => void, finish!: (value: { message_id: number }) => void;
  const progress = new Promise<void>((resolve) => {
      started = resolve;
    }),
    pending = new Promise<{ message_id: number }>((resolve) => {
      finish = resolve;
    });
  const api = {
    typing: async () => {},
    call: async (method: string) => {
      if (method === 'sendRichMessage') {
        started();
        return pending;
      }
      if (method === 'getChatMember') return { status: 'administrator' };
      return {};
    },
  } as unknown as TelegramAssistantApi;
  const llm: AssistantLlm = {
    complete: async (_messages, _tools, _signal, onContent) => {
      onContent!('Synthetic group draft');
      return { message: { role: 'assistant', content: 'Stale group final' } };
    },
  };
  const ingress = new AssistantIngress(store, config, analytics, api, {
      id: 99,
      username: 'goodkiddo_bot',
    }),
    worker = new AssistantWorker(config, store, analytics, llm, api);
  try {
    await ingress.handle({
      update_id: 501,
      message: {
        message_id: 1,
        from: { id: 1 },
        chat: { id: -2, type: 'supergroup' },
        text: '@goodkiddo_bot synthetic old request',
      },
    });
    worker.wake();
    await progress;
    await ingress.handle({
      update_id: 502,
      message: {
        message_id: 2,
        from: { id: 1 },
        chat: { id: -2, type: 'supergroup' },
        text: '/clear@goodkiddo_bot',
      },
    });
    finish({ message_id: 777 });
    await worker.idle();
    expect(store.history('-2')).toEqual([]);
    expect(store.db.query('SELECT status FROM assistant_runs').get()).toEqual({
      status: 'cancelled',
    });
    expect(
      (
        store.db.query('SELECT id FROM assistant_outbox').all() as {
          id: string;
        }[]
      ).every((row) => row.id.startsWith('command:502')),
    ).toBe(true);
    expect(
      store.db
        .query(
          "SELECT key FROM assistant_state WHERE key LIKE 'delivery_hold:%'",
        )
        .all(),
    ).toEqual([]);
  } finally {
    await worker.stop();
    store.close();
  }
});
