import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.ts';
import { AssistantFiles } from '../src/persistence/assistant-files.ts';
import {
  queueDocument,
  documentDelivery,
} from '../src/persistence/assistant-document-outbox.ts';
import {
  batchParts,
  deliveryBatch,
  deliveryPart,
  expireDeliverySnapshots,
} from '../src/persistence/assistant-delivery-ledger.ts';
import {
  DeliveryRetryConfirmation,
  retryDelivery,
} from '../src/persistence/assistant-delivery-retry.ts';
import {
  DELIVERY_LIMITS,
  DELIVERY_RETENTION_MS,
} from '../src/persistence/assistant-delivery-schema.ts';
import { deliveryStatus } from '../src/assistant/delivery-status.ts';
import { deliveryCommand } from '../src/assistant/delivery-commands.ts';
import { clearChatContext } from '../src/assistant/context.ts';
import { AssistantIngress } from '../src/assistant/ingress.ts';
import { enqueueReply } from '../src/assistant/messages.ts';
import { deliverMessages } from '../src/assistant/delivery.ts';
import {
  cancelJobDelivery,
  queueJobDelivery,
  retryJobDelivery,
} from '../src/tasks/assistant-job-delivery.ts';
import {
  TelegramApiError,
  TelegramAssistantApi,
} from '../src/channels/telegram-assistant-api.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';

const stores: AssistantStore[] = [];
function setup(file = ':memory:') {
  const store = new AssistantStore(file),
    config = fileConfig(),
    analytics = new AssistantAnalytics(config, store);
  stores.push(store);
  store.saveChat({ id: '1', type: 'private', timezone: 'UTC', active: 1 });
  store.saveChat({ id: '2', type: 'private', timezone: 'UTC', active: 1 });
  store.startRun('run', store.chat('1')!, '1', 'other');
  const api = {
    send: async () => 123,
    sendDocument: async () => 456,
    editRich: async () => {},
    typing: async () => {},
    call: async () => ({ status: 'administrator' }),
  } as unknown as TelegramAssistantApi;
  return {
    store,
    config,
    analytics,
    api,
    files: new AssistantFiles(store.db, config.fileLimits),
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
});
function queue(s: ReturnType<typeof setup>, text = 'x'.repeat(16000)) {
  const ids = enqueueReply(s.store, 'reply:run', '1', text, {
    runId: 'run',
    ownerId: '1',
    threadId: 7,
  });
  for (const id of ids) s.store.setState(`delivery_run:${id}`, 'run');
  return { ids, batch: deliveryPart(s.store, ids[0])!.batch_id, text };
}

test('full 16000-character immutable reply survives ambiguous partial delivery and 12000-character history', async () => {
  const s = setup(),
    q = queue(s);
  s.store.remember('1', 'assistant', q.text);
  let sends = 0;
  s.api.send = async () => {
    if (++sends === 2) throw new TelegramApiError(0);
    return 123;
  };
  await deliverMessages(s.store, s.api, s.analytics);
  await deliverMessages(s.store, s.api, s.analytics);
  for (let i = 0; i < 3; i++)
    await deliverMessages(s.store, s.api, s.analytics);
  expect(sends).toBe(2);
  expect(s.store.history('1')[0].content!.length).toBe(12000);
  expect(deliveryBatch(s.store, '1', q.batch)?.full_text).toBe(q.text);
  expect(batchParts(s.store, q.batch).map((p) => p.status)).toEqual([
    'sent',
    'uncertain',
    ...q.ids.slice(2).map(() => 'blocked' as const),
  ]);
  expect(batchParts(s.store, q.batch).every((p) => p.text.length > 0)).toBe(
    true,
  );
  expect(s.store.db.query('SELECT id FROM assistant_outbox').all()).toEqual([]);
  expect(
    deliveryCommand(s.store, '/retry_delivery', [q.batch], '1', '1'),
  ).toContain('дубликат');
  expect(() => retryDelivery(s.store, '1', '1', q.batch)).toThrow(
    DeliveryRetryConfirmation,
  );
  expect(s.store.db.query('SELECT id FROM assistant_outbox').all()).toEqual([]);
  expect(() => retryDelivery(s.store, '2', '1', q.batch, true)).toThrow(
    'этом чате',
  );
  expect(() => retryDelivery(s.store, '1', '2', q.batch, true)).toThrow(
    'автор',
  );
  const sentChunks: string[] = [];
  s.api.send = async (_chat, text, _markup, thread) => {
    expect(thread).toBe(7);
    sentChunks.push(text);
    return 789;
  };
  retryDelivery(s.store, '1', '1', q.batch, true);
  for (let i = 0; i < q.ids.length; i++)
    await deliverMessages(s.store, s.api, s.analytics);
  expect(sentChunks).toEqual(
    batchParts(s.store, q.batch)
      .slice(1)
      .map((p) => p.text),
  );
  expect(batchParts(s.store, q.batch).every((p) => p.status === 'sent')).toBe(
    true,
  );
  expect(deliveryStatus(s.store, '1', q.batch)[0].possible_duplicate).toBe(
    true,
  );
  expect(() => retryDelivery(s.store, '1', '1', q.batch, true)).toThrow(
    'Нет частей',
  );
  expect(() =>
    enqueueReply(s.store, 'reply:run', '1', 'altered', {
      runId: 'run',
      ownerId: '1',
    }),
  ).toThrow('неизменяем');
});

test('document timeout keeps original bytes/caption/topic and only explicit confirmed retry can resend', async () => {
  const s = setup();
  s.files.write('1', '/a.txt', new TextEncoder().encode('original'));
  const d = queueDocument(
    s.store,
    s.files,
    '1',
    '/a.txt',
    'original caption',
    'run',
    { ownerId: '1', threadId: 11 },
  );
  const q = queue(s, 'Final text');
  s.files.edit('1', '/a.txt', 'original', 'changed');
  let calls = 0;
  s.api.sendDocument = async () => {
    calls++;
    throw new TelegramApiError(500);
  };
  await deliverMessages(s.store, s.api, s.analytics);
  await deliverMessages(s.store, s.api, s.analytics);
  expect(calls).toBe(1);
  expect(documentDelivery(s.store, d.id, '1')?.status).toBe('uncertain');
  expect(
    new TextDecoder().decode(documentDelivery(s.store, d.id, '1')!.content!),
  ).toBe('original');
  expect(deliveryPart(s.store, q.ids[0])?.status).toBe('blocked');
  expect(() => retryDelivery(s.store, '1', '1', q.batch)).toThrow('дубликат');
  s.api.sendDocument = async (chat, file, caption, thread) => {
    calls++;
    expect(chat).toBe('1');
    expect(new TextDecoder().decode(file.content)).toBe('original');
    expect(caption).toBe('original caption');
    expect(thread).toBe(11);
    return 44;
  };
  retryDelivery(s.store, '1', '1', q.batch, true);
  await deliverMessages(s.store, s.api, s.analytics);
  await deliverMessages(s.store, s.api, s.analytics);
  expect(calls).toBe(2);
  expect(documentDelivery(s.store, d.id, '1')).toMatchObject({
    status: 'sent',
    content: null,
  });
  expect(deliveryPart(s.store, d.id)).toMatchObject({
    status: 'sent',
    message_id: 44,
    uncertain_count: 1,
  });
});

test('restart during a new document send suppresses resend and retains all recovery payloads', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'goodkiddo-delivery-'));
  try {
    let s = setup(join(folder, 'db.sqlite'));
    s.files.write('1', '/a.txt', new TextEncoder().encode('snapshot'));
    const d = queueDocument(s.store, s.files, '1', '/a.txt', 'caption', 'run', {
      ownerId: '1',
    });
    s.store.db
      .query("UPDATE assistant_file_deliveries SET status='sending' WHERE id=?")
      .run(d.id);
    s.store.db
      .query(
        "UPDATE assistant_delivery_parts SET status='sending',attempts=1 WHERE id=?",
      )
      .run(d.id);
    s.store.close();
    stores.pop();
    s = setup(join(folder, 'db.sqlite'));
    let calls = 0;
    s.api.sendDocument = async () => {
      calls++;
      return 1;
    };
    await deliverMessages(s.store, s.api, s.analytics);
    expect(calls).toBe(0);
    expect(deliveryPart(s.store, d.id)?.status).toBe('uncertain');
    expect(documentDelivery(s.store, d.id, '1')!.content!.length).toBe(8);
  } finally {
    for (const store of stores.splice(0)) store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('known final edits safely retry an ambiguous response without a new send', async () => {
  const s = setup(),
    ids = enqueueReply(s.store, 'edit', '1', 'Final', {
      ownerId: '1',
      messageId: 321,
    });
  let edits = 0,
    sends = 0;
  s.api.send = async () => {
    sends++;
    return 42;
  };
  s.api.editRich = async (_chat, id, text) => {
    expect(id).toBe(321);
    expect(text).toBe('Final');
    if (++edits === 1) throw new TelegramApiError(0);
  };
  await deliverMessages(s.store, s.api, s.analytics);
  expect(deliveryPart(s.store, ids[0])?.status).toBe('pending');
  s.store.db
    .query("UPDATE assistant_outbox SET next_attempt='2000-01-01'")
    .run();
  await deliverMessages(s.store, s.api, s.analytics);
  expect(edits).toBe(2);
  expect(sends).toBe(0);
  expect(deliveryPart(s.store, ids[0])?.status).toBe('sent');
});

test('definitive document 429 can retry automatically, while 400 retains immutable failed snapshot', async () => {
  const s = setup();
  s.files.write('1', '/a.txt', new TextEncoder().encode('bytes'));
  const d = queueDocument(s.store, s.files, '1', '/a.txt', '', 'run', {
    ownerId: '1',
  });
  s.api.sendDocument = async () => {
    throw new TelegramApiError(429, 2);
  };
  await deliverMessages(s.store, s.api, s.analytics);
  expect(deliveryPart(s.store, d.id)?.status).toBe('pending');
  s.store.db
    .query("UPDATE assistant_outbox SET attempts=2,next_attempt='2000-01-01'")
    .run();
  s.api.sendDocument = async () => {
    throw new TelegramApiError(400);
  };
  await deliverMessages(s.store, s.api, s.analytics);
  expect(deliveryPart(s.store, d.id)?.status).toBe('failed');
  expect(
    new TextDecoder().decode(documentDelivery(s.store, d.id, '1')!.content!),
  ).toBe('bytes');
  const batch = deliveryPart(s.store, d.id)!.batch_id;
  retryDelivery(s.store, '1', '1', batch);
  expect(
    s.store.db.query('SELECT id FROM assistant_outbox').all(),
  ).toHaveLength(1);
});

test('snapshot expiry releases bytes/rows/receipts, retains source files, and enforces bounded text quota', async () => {
  const s = setup();
  s.files.write('1', '/a.txt', new TextEncoder().encode('bytes'));
  const d = queueDocument(s.store, s.files, '1', '/a.txt', '', 'run', {
      ownerId: '1',
    }),
    q = queue(s, 'saved text');
  const batch = deliveryBatch(s.store, '1', q.batch)!;
  expect(batch.expires_at - batch.created_at).toBe(DELIVERY_RETENTION_MS);
  expireDeliverySnapshots(s.store, batch.expires_at + 1);
  expect(deliveryBatch(s.store, '1', q.batch)).toBeNull();
  expect(documentDelivery(s.store, d.id, '1')).toMatchObject({
    status: 'expired',
    content: null,
  });
  expect(s.files.read('1', '/a.txt').text).toContain('bytes');
  expect(
    s.store.db.query('SELECT id FROM assistant_outbox').all(),
  ).toHaveLength(0);
  expect(
    s.store.db.query('SELECT id FROM assistant_text_deliveries').all(),
  ).toHaveLength(0);
  expect(() =>
    enqueueReply(
      s.store,
      'large',
      '1',
      'x'.repeat(DELIVERY_LIMITS.maxReplyBytes + 1),
      { ownerId: '1' },
    ),
  ).toThrow('лимит');
  expect(
    s.store.db.query('SELECT id FROM assistant_delivery_batches').all(),
  ).toHaveLength(0);
});

test('clear purges response recovery payloads and cancels ambiguous docs without touching source VFS', async () => {
  const s = setup();
  s.files.write('1', '/a.txt', new TextEncoder().encode('keep source'));
  const d = queueDocument(s.store, s.files, '1', '/a.txt', '', 'run', {
      ownerId: '1',
    }),
    q = queue(s, 'private reply');
  s.api.sendDocument = async () => {
    throw new TelegramApiError(0);
  };
  await deliverMessages(s.store, s.api, s.analytics);
  clearChatContext(s.store, '1');
  expect(deliveryBatch(s.store, '1', q.batch)?.full_text).toBeNull();
  expect(
    batchParts(s.store, q.batch).every(
      (p) => !p.text && p.status === 'cancelled',
    ),
  ).toBe(true);
  expect(documentDelivery(s.store, d.id, '1')).toMatchObject({
    status: 'cancelled',
    content: null,
  });
  expect(s.files.read('1', '/a.txt').text).toContain('keep source');
  expect(() => retryDelivery(s.store, '1', '1', q.batch, true)).toThrow(
    'Нет частей',
  );
});

test('failed reminder retry skips acknowledged chunks, requires ambiguity consent, and cancellation forbids retry', async () => {
  const s = setup(),
    job = {
      id: 'job',
      chat_id: '1',
      owner_id: '1',
      kind: 'reminder' as const,
      title: 'synthetic',
      due_at: new Date().toISOString(),
      remind_at: null,
      reminded: 0,
      status: 'active' as const,
      data: '{}',
      created_at: new Date().toISOString(),
    };
  s.store.createJob(job, 'synthetic');
  const run = queueJobDelivery(s.store, job, 'x'.repeat(6000));
  let sends = 0;
  s.api.send = async () => {
    if (++sends === 2) throw new TelegramApiError(0);
    return 321;
  };
  await deliverMessages(s.store, s.api, s.analytics);
  await deliverMessages(s.store, s.api, s.analytics);
  expect(s.store.job(job.id)?.status).toBe('delivery_failed');
  expect(() => retryJobDelivery(s.store, '1', '1', job.id)).toThrow('дубликат');
  retryJobDelivery(s.store, '1', '1', job.id, true);
  s.api.send = async () => {
    sends++;
    return 45;
  };
  await deliverMessages(s.store, s.api, s.analytics);
  expect(sends).toBe(3);
  expect(s.store.job(job.id)?.status).toBe('completed');
  expect(
    s.store.db.query('SELECT COUNT(*) n FROM assistant_job_deliveries').get(),
  ).toEqual({ n: 1 });
  expect(run).toBe('scheduled:job:1');
});

test('cancelling a failed task forbids direct delivery retry as well as job retry', async () => {
  const s = setup(),
    job = {
      id: 'job',
      chat_id: '1',
      owner_id: '1',
      kind: 'reminder' as const,
      title: 'synthetic',
      due_at: new Date().toISOString(),
      remind_at: null,
      reminded: 0,
      status: 'active' as const,
      data: '{}',
      created_at: new Date().toISOString(),
    };
  s.store.createJob(job, 'synthetic');
  queueJobDelivery(s.store, job, 'saved');
  s.api.send = async () => {
    throw new TelegramApiError(0);
  };
  await deliverMessages(s.store, s.api, s.analytics);
  const batch = deliveryStatus(s.store, '1')[0].id;
  cancelJobDelivery(s.store, s.store.job(job.id)!);
  expect(() => retryDelivery(s.store, '1', '1', batch, true)).toThrow(
    'отменена',
  );
  expect(
    s.store.db.query('SELECT id FROM assistant_outbox').all(),
  ).toHaveLength(0);
});

test('forwarded retry command cannot authorize resend; ordinary same-chat commands provide status and explicit warning', async () => {
  const s = setup(),
    q = queue(s, 'Synthetic');
  s.api.send = async () => {
    throw new TelegramApiError(0);
  };
  await deliverMessages(s.store, s.api, s.analytics);
  const ingress = new AssistantIngress(s.store, s.config, s.analytics, s.api, {
    id: 99,
    username: 'goodkiddo_bot',
  });
  const base = {
    message_id: 2,
    chat: { id: 1, type: 'private' as const },
    from: { id: 1 },
    text: '/retry_delivery ' + q.batch + ' confirm',
    date: 1700000000,
  };
  await ingress.handle({
    update_id: 1,
    message: { ...base, forward_origin: { type: 'user', date: 1690000000 } },
  });
  expect(deliveryPart(s.store, q.ids[0])?.status).toBe('uncertain');
  await ingress.handle({
    update_id: 2,
    message: { ...base, text: '/delivery ' + q.batch },
  });
  const rows = s.store.db.query('SELECT text FROM assistant_outbox').all() as {
    text: string;
  }[];
  expect(rows.some((r) => r.text.includes('результат неизвестен'))).toBe(true);
  expect(JSON.stringify(deliveryStatus(s.store, '1', q.batch))).not.toContain(
    'Synthetic',
  );
  expect(() => deliveryStatus(s.store, '2', q.batch)).toThrow('этом чате');
});

test('concurrent delivery ticks never perform a competing new send', async () => {
  const s = setup(),
    q = queue(s, 'one');
  let calls = 0,
    release!: (n: number) => void;
  const pending = new Promise<number>((resolve) => {
    release = resolve;
  });
  s.api.send = async () => {
    calls++;
    return pending;
  };
  const first = deliverMessages(s.store, s.api, s.analytics),
    second = deliverMessages(s.store, s.api, s.analytics);
  expect(calls).toBe(1);
  release(123);
  await Promise.all([first, second]);
  expect(deliveryPart(s.store, q.ids[0])?.status).toBe('sent');
});

test('capacity pruning removes old acknowledged records and never evicts an unresolved reply', async () => {
  const s = setup(),
    q = queue(s, 'acknowledged');
  await deliverMessages(s.store, s.api, s.analytics);
  s.store.db
    .query('UPDATE assistant_delivery_batches SET full_text=? WHERE id=?')
    .run('x'.repeat(DELIVERY_LIMITS.maxChatTextBytes), q.batch);
  enqueueReply(s.store, 'fresh', '1', 'New response', { ownerId: '1' });
  expect(deliveryBatch(s.store, '1', q.batch)).toBeNull();
  const unresolved = deliveryStatus(s.store, '1')[0].id;
  s.store.db
    .query('UPDATE assistant_delivery_batches SET full_text=? WHERE id=?')
    .run('x'.repeat(DELIVERY_LIMITS.maxChatTextBytes), unresolved);
  expect(() =>
    enqueueReply(s.store, 'blocked-by-capacity', '1', 'Cannot evict', {
      ownerId: '1',
    }),
  ).toThrow('лимит');
  expect(deliveryBatch(s.store, '1', unresolved)).not.toBeNull();
});

test('restart after a confirmed text receipt reconciles sent status without transmitting again', async () => {
  const s = setup(),
    q = queue(s, 'Acknowledged before shutdown');
  s.store.db
    .query(
      "UPDATE assistant_text_deliveries SET status='sent',message_id=123 WHERE id=?",
    )
    .run(q.ids[0]);
  let calls = 0;
  s.api.send = async () => {
    calls++;
    return 2;
  };
  await deliverMessages(s.store, s.api, s.analytics);
  expect(calls).toBe(0);
  expect(deliveryPart(s.store, q.ids[0])).toMatchObject({
    status: 'sent',
    message_id: 123,
  });
});

test('malformed Telegram success without a message ID is treated as ambiguous, with no fallback or retry', async () => {
  const s = setup(),
    q = queue(s, 'Synthetic text'),
    original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ ok: true, result: {} });
    }) as unknown as typeof fetch;
    const api = new TelegramAssistantApi('synthetic-credential');
    await deliverMessages(s.store, api, s.analytics);
    await deliverMessages(s.store, api, s.analytics);
    expect(calls).toBe(1);
    expect(deliveryPart(s.store, q.ids[0])?.status).toBe('uncertain');
    s.files.write('1', '/a.txt', new TextEncoder().encode('snapshot'));
    const d = queueDocument(
      s.store,
      s.files,
      '1',
      '/a.txt',
      '',
      'different-run',
      { ownerId: '1' },
    );
    await deliverMessages(s.store, api, s.analytics);
    await deliverMessages(s.store, api, s.analytics);
    expect(calls).toBe(2);
    expect(documentDelivery(s.store, d.id, '1')?.status).toBe('uncertain');
  } finally {
    globalThis.fetch = original;
  }
});
