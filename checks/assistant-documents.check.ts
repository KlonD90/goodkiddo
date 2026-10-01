import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantFiles } from '../src/persistence/assistant-files.ts';
import { textBytes } from '../src/persistence/assistant-file-policy.ts';
import {
  queueDocument,
  documentDelivery,
} from '../src/persistence/assistant-document-outbox.ts';
import { AssistantIngress } from '../src/assistant/ingress.ts';
import { deliverMessages } from '../src/assistant/delivery.ts';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.ts';
import {
  TelegramAssistantApi,
  TelegramApiError,
  type TelegramMessage,
} from '../src/channels/telegram-assistant-api.ts';
import { boundedDocumentBody } from '../src/channels/telegram-document-body.ts';
import {
  toolDefinitions,
  executeTool,
  type ToolContext,
} from '../src/assistant/tools.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';

function setup(dbPath = ':memory:') {
  const config = fileConfig(),
    store = new AssistantStore(dbPath),
    analytics = new AssistantAnalytics(config, store);
  const files = new AssistantFiles(store.db, config.fileLimits);
  const downloads: string[] = [],
    sent: { chat: string; text: string; bytes?: string }[] = [];
  const api = {
    downloadDocument: async (id: string) => {
      downloads.push(id);
      return textBytes('synthetic document');
    },
    send: async (chat: string, text: string) => {
      sent.push({ chat, text });
    },
    sendDocument: async (
      chat: string,
      file: { content: Uint8Array },
      text: string,
    ) => {
      sent.push({ chat, text, bytes: new TextDecoder().decode(file.content) });
    },
  } as unknown as TelegramAssistantApi;
  const ingress = new AssistantIngress(store, config, analytics, api, {
    id: 99,
    username: 'goodkiddo_bot',
    is_bot: true,
  });
  return { config, store, analytics, files, api, ingress, downloads, sent };
}
function message(
  chatType: 'private' | 'supergroup' = 'private',
  caption?: string,
): TelegramMessage {
  return {
    message_id: 1,
    date: 1700000000,
    from: { id: 1, first_name: 'Synthetic' },
    chat: { id: chatType === 'private' ? 1 : -2, type: chatType },
    caption,
    document: {
      file_id: 'test-file-id',
      file_name: '../../report.txt',
      mime_type: 'text/plain',
      file_size: 18,
    },
  };
}
function prepareRun(s: ReturnType<typeof setup>, id = 'task') {
  s.store.saveChat({ id: '1', type: 'private', timezone: 'UTC', active: 1 });
  s.analytics.start(id, s.store.chat('1')!, '1', 'other', 'user');
}

test('document-only intake persists once with source time and queues same-chat acknowledgement', async () => {
  const s = setup();
  try {
    expect(await s.ingress.handle({ update_id: 1, message: message() })).toBe(
      'stored_document',
    );
    const info = s.files.list('1')[0];
    expect(info.path).toBe('/uploads/telegram-1/report.txt');
    expect(info.source_date).toBe('2023-11-14T22:13:20.000Z');
    s.files.edit('1', info.path, 'synthetic', 'edited');
    await s.ingress.handle({ update_id: 1, message: message() });
    expect(s.downloads).toEqual(['test-file-id']);
    expect(s.files.read('1', info.path).text).toContain('edited');
    expect(s.store.nextRequest()).toBeUndefined();
    await deliverMessages(s.store, s.api, s.analytics);
    expect(s.sent[0].chat).toBe('1');
  } finally {
    s.store.close();
  }
});
test('group document gate rejects unaddressed before download, accepts mention and reply captions', async () => {
  const s = setup();
  try {
    expect(
      await s.ingress.handle({ update_id: 2, message: message('supergroup') }),
    ).toBe('ignored_unaddressed');
    expect(s.downloads.length).toBe(0);
    expect(
      await s.ingress.handle({
        update_id: 3,
        message: message('supergroup', '@goodkiddo_bot read this'),
      }),
    ).toBe('enqueued_mention');
    const request = s.store.nextRequest()!;
    expect(request.chat.id).toBe('-2');
    expect(request.text).toContain('/uploads/telegram-3/report.txt');
    expect(request.userText).toBe('@goodkiddo_bot read this');
    expect(request.messageDate).toBe('2023-11-14T22:13:20.000Z');
    const reply = message('supergroup');
    reply.reply_to_message = { from: { id: 99 } };
    expect(await s.ingress.handle({ update_id: 4, message: reply })).toBe(
      'stored_document',
    );
    expect(() => s.files.get('1', '/uploads/telegram-3/report.txt')).toThrow();
  } finally {
    s.store.close();
  }
});
test('forwarded captions and slash captions never execute commands; upload quota rejects safely', async () => {
  const s = setup();
  try {
    s.store.remember('1', 'user', 'synthetic previous context');
    const forwarded = message('private', '/clear');
    forwarded.forward_origin = { date: 1600000000, type: 'user' };
    expect(await s.ingress.handle({ update_id: 5, message: forwarded })).toBe(
      'stored_document',
    );
    expect(s.store.history('1').length).toBe(1);
    expect(s.store.nextRequest()).toBeUndefined();
    expect(s.files.list('1')[0].source_date).toBe('2020-09-13T12:26:40.000Z');
    expect(
      await s.ingress.handle({
        update_id: 6,
        message: message('private', '/clear'),
      }),
    ).toBe('enqueued_command');
    expect(s.store.history('1').length).toBe(1);
    const large = message();
    large.document!.file_size = s.config.fileLimits.maxFileBytes + 1;
    expect(await s.ingress.handle({ update_id: 7, message: large })).toBe(
      'rejected_document',
    );
    expect(s.downloads.length).toBe(2);
    expect(s.files.list('1').length).toBe(2);
  } finally {
    s.store.close();
  }
});
test('file tools are exposed, destination is current chat and send snapshot survives editing', async () => {
  const s = setup();
  try {
    prepareRun(s);
    const request = {
      updateId: 8,
      chat: s.store.chat('1')!,
      actor: { id: '1', name: 'Synthetic' },
      text: 'create and send report',
      interaction: 'message' as const,
    };
    const ctx: ToolContext = {
      store: s.store,
      config: s.config,
      request,
      taskId: 'task',
      signal: new AbortController().signal,
      searches: 0,
    };
    const names = toolDefinitions(false).map((t) => t.function.name);
    for (const name of [
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'send_file',
    ])
      expect(names).toContain(name);
    await executeTool(
      'write_file',
      JSON.stringify({ file_path: '/report.txt', content: 'old' }),
      ctx,
    );
    const result = (await executeTool(
      'send_file',
      JSON.stringify({
        file_path: '/report.txt',
        chat_id: '-2',
        caption: 'caption',
      }),
      ctx,
    )) as { id: string };
    s.files.edit('1', '/report.txt', 'old', 'new');
    expect(documentDelivery(s.store, result.id, '-2')).toBeNull();
    await deliverMessages(s.store, s.api, s.analytics);
    expect(s.sent).toEqual([{ chat: '1', text: 'caption', bytes: 'old' }]);
    expect(documentDelivery(s.store, result.id, '1')).toMatchObject({
      status: 'sent',
      content: null,
    });
    // Same operation and unchanged content cannot silently requeue after completion.
    const replay = queueDocument(
      s.store,
      s.files,
      '1',
      '/report.txt',
      'caption',
      'task2',
    );
    await deliverMessages(s.store, s.api, s.analytics);
    expect(
      queueDocument(s.store, s.files, '1', '/report.txt', 'caption', 'task2')
        .status,
    ).toBe('sent');
    expect(s.sent.length).toBe(2);
    expect(documentDelivery(s.store, replay.id, '1')?.content).toBeNull();
    await expect(
      executeTool(
        'read_file',
        JSON.stringify({ file_path: '/etc/passwd' }),
        ctx,
      ),
    ).rejects.toThrow('Файл не найден');
  } finally {
    s.store.close();
  }
});
test('queued documents persist over reopen, hold delivery until final reply, and retry flood control', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'goodkiddo-doc-check-')),
    dbPath = join(folder, 'assistant.db');
  let s = setup(dbPath);
  try {
    prepareRun(s);
    s.files.write('1', '/a.txt', textBytes('persisted'));
    const queued = queueDocument(s.store, s.files, '1', '/a.txt', '', 'task');
    s.store.setState('delivery_hold:task', '1');
    await deliverMessages(s.store, s.api, s.analytics);
    expect(s.sent.length).toBe(0);
    s.store.close();
    s = setup(dbPath);
    expect(documentDelivery(s.store, queued.id, '1')?.status).toBe('pending');
    s.store.send('final', '1', 'finished');
    s.store.setState('delivery_run:final', 'task');
    s.store.db
      .query('DELETE FROM assistant_state WHERE key=?')
      .run('delivery_hold:task');
    const send = s.api.sendDocument.bind(s.api);
    s.api.sendDocument = async () => {
      throw new TelegramApiError(429, 1);
    };
    await deliverMessages(s.store, s.api, s.analytics);
    expect(documentDelivery(s.store, queued.id, '1')?.status).toBe('pending');
    expect(s.sent.length).toBe(0);
    s.api.sendDocument = send;
    s.store.db
      .query("UPDATE assistant_outbox SET next_attempt='2000-01-01'")
      .run();
    await deliverMessages(s.store, s.api, s.analytics);
    expect(
      (
        s.store.db
          .query('SELECT status FROM assistant_runs WHERE id=?')
          .get('task') as { status: string }
      ).status,
    ).toBe('running');
    await deliverMessages(s.store, s.api, s.analytics);
    expect(
      (
        s.store.db
          .query('SELECT status FROM assistant_runs WHERE id=?')
          .get('task') as { status: string }
      ).status,
    ).toBe('success');
    expect(s.sent.length).toBe(2);
  } finally {
    s.store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
test('failed document retains immutable bytes, blocks remaining parts, and obeys snapshot quota', async () => {
  const s = setup();
  try {
    prepareRun(s);
    s.files.write('1', '/a.txt', textBytes('abcd'));
    s.files.write('1', '/b.txt', textBytes('wxyz'));
    const limited = new AssistantFiles(s.store.db, {
      ...s.config.fileLimits,
      maxChatBytes: 9,
    });
    expect(() =>
      queueDocument(s.store, limited, '1', '/a.txt', '', 'task'),
    ).toThrow('объёма файлов');
    const a = queueDocument(s.store, s.files, '1', '/a.txt', '', 'task'),
      b = queueDocument(s.store, s.files, '1', '/b.txt', '', 'task');
    s.api.sendDocument = async () => {
      throw new TelegramApiError(400);
    };
    s.store.db.query('UPDATE assistant_outbox SET attempts=2').run();
    await deliverMessages(s.store, s.api, s.analytics);
    expect(documentDelivery(s.store, a.id, '1')?.status).toBe('error');
    expect(documentDelivery(s.store, b.id, '1')).toMatchObject({
      status: 'blocked',
    });
    expect(
      new TextDecoder().decode(documentDelivery(s.store, a.id, '1')!.content!),
    ).toBe('abcd');
    expect(
      new TextDecoder().decode(documentDelivery(s.store, b.id, '1')!.content!),
    ).toBe('wxyz');
    expect(
      (
        s.store.db
          .query('SELECT status FROM assistant_runs WHERE id=?')
          .get('task') as { status: string }
      ).status,
    ).toBe('error');
  } finally {
    s.store.close();
  }
});
test('download is bounded even without Content-Length; Telegram transport uses fixed host and multipart', async () => {
  await expect(
    boundedDocumentBody(
      new Response('oversized', { headers: { 'Content-Length': '50' } }),
      2,
    ),
  ).rejects.toThrow('размер');
  await expect(
    boundedDocumentBody(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(textBytes('123'));
            c.enqueue(textBytes('456'));
            c.close();
          },
        }),
      ),
      5,
    ),
  ).rejects.toThrow('размер');
  const original = globalThis.fetch,
    calls: { url: string; init?: RequestInit }[] = [];
  try {
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/getFile'))
        return Response.json({
          ok: true,
          result: { file_path: 'documents/file.txt', file_size: 4 },
        });
      if (String(url).includes('/file/bot')) return new Response('safe');
      return Response.json({ ok: true, result: { message_id: 123 } });
    }) as unknown as typeof fetch;
    const api = new TelegramAssistantApi('synthetic-test-credential');
    expect(new TextDecoder().decode(await api.downloadDocument('id', 20))).toBe(
      'safe',
    );
    await api.sendDocument(
      '1',
      {
        filename: '../../file.txt',
        mime_type: 'text/plain',
        content: textBytes('safe'),
      },
      'caption',
    );
    expect(
      calls.every(
        (c) =>
          new URL(c.url).hostname === 'api.telegram.org' &&
          c.init?.redirect === 'error',
      ),
    ).toBe(true);
    const body = calls.at(-1)!.init!.body as FormData;
    expect(body.get('chat_id')).toBe('1');
    expect((body.get('document') as File).name).toBe('file.txt');
    expect(await (body.get('document') as File).text()).toBe('safe');
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        result: { file_path: '../sensitive' },
      })) as unknown as typeof fetch;
    await expect(api.downloadDocument('id', 20)).rejects.toThrow('путь');
    globalThis.fetch = (async () => {
      throw new Error('synthetic private transport URL');
    }) as unknown as typeof fetch;
    await expect(api.call('getFile')).rejects.toThrow(
      'Telegram request failed (0)',
    );
  } finally {
    globalThis.fetch = original;
  }
});
