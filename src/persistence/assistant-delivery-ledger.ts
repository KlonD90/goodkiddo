import { createHash } from 'node:crypto';
import type { AssistantStore } from './assistant-store.js';
import {
  DELIVERY_LIMITS,
  DELIVERY_RETENTION_MS,
} from './assistant-delivery-schema.js';

export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'uncertain'
  | 'failed'
  | 'blocked'
  | 'cancelled';
export interface DeliveryBatch {
  id: string;
  chat_id: string;
  source_key: string;
  owner_id: string | null;
  run_id: string | null;
  full_text: string | null;
  created_at: number;
  expires_at: number;
}
export interface DeliveryPart {
  id: string;
  batch_id: string;
  chat_id: string;
  kind: 'text' | 'document';
  ordinal: number;
  text: string;
  markup: string | null;
  thread_id: number | null;
  message_id: number | null;
  status: DeliveryStatus;
  attempts: number;
  uncertain_count: number;
}
export interface DeliveryOrigin {
  runId?: string;
  ownerId?: string;
  threadId?: number;
  messageId?: number;
}

export function deliveryPart(
  store: AssistantStore,
  id: string,
): DeliveryPart | null {
  return store.db
    .query('SELECT * FROM assistant_delivery_parts WHERE id=?')
    .get(id) as DeliveryPart | null;
}
export function batchParts(store: AssistantStore, id: string): DeliveryPart[] {
  return store.db
    .query(
      'SELECT * FROM assistant_delivery_parts WHERE batch_id=? ORDER BY ordinal',
    )
    .all(id) as DeliveryPart[];
}
export function deliveryBatch(
  store: AssistantStore,
  chatId: string,
  id: string,
): DeliveryBatch | null {
  return store.db
    .query('SELECT * FROM assistant_delivery_batches WHERE id=? AND chat_id=?')
    .get(id, chatId) as DeliveryBatch | null;
}

export function expireDeliverySnapshots(
  store: AssistantStore,
  now = Date.now(),
): void {
  store.transaction(() => {
    const expired = store.db
      .query(
        'SELECT id,run_id FROM assistant_delivery_batches WHERE expires_at<=?',
      )
      .all(now) as { id: string; run_id: string | null }[];
    for (const batch of expired) {
      removeSnapshot(store, batch, now);
    }
  });
}

function removeSnapshot(
  store: AssistantStore,
  batch: { id: string; run_id: string | null },
  now: number,
): void {
  for (const part of batchParts(store, batch.id)) {
    store.db
      .query(
        "UPDATE assistant_file_deliveries SET content=NULL,status='expired',finished_at=? WHERE id=?",
      )
      .run(new Date(now).toISOString(), part.id);
    store.db.query('DELETE FROM assistant_outbox WHERE id=?').run(part.id);
    store.db
      .query('DELETE FROM assistant_state WHERE key=?')
      .run(`delivery_run:${part.id}`);
    // Text receipts are created lazily by the worker/delivery adapter.
    if (
      store.db
        .query(
          "SELECT 1 FROM sqlite_master WHERE name='assistant_text_deliveries'",
        )
        .get()
    )
      store.db
        .query('DELETE FROM assistant_text_deliveries WHERE id=?')
        .run(part.id);
  }
  if (batch.run_id) {
    store.db
      .query(
        "UPDATE assistant_jobs SET status='delivery_failed' WHERE status='delivering' AND id IN (SELECT job_id FROM assistant_job_deliveries WHERE run_id=?)",
      )
      .run(batch.run_id);
    store.db
      .query(
        "UPDATE assistant_runs SET status='error',finished_at=? WHERE id=? AND status='running'",
      )
      .run(new Date(now).toISOString(), batch.run_id);
    if (
      store.db
        .query("SELECT 1 FROM sqlite_master WHERE name='assistant_prompt_runs'")
        .get()
    )
      store.db
        .query(
          "UPDATE assistant_prompt_runs SET status='delivery_failed',finished_at=? WHERE id=? AND status='awaiting_delivery'",
        )
        .run(new Date(now).toISOString(), batch.run_id);
  }
  store.db
    .query('DELETE FROM assistant_delivery_parts WHERE batch_id=?')
    .run(batch.id);
  store.db
    .query('DELETE FROM assistant_delivery_batches WHERE id=?')
    .run(batch.id);
}

function reserveText(
  store: AssistantStore,
  chatId: string,
  bytes: number,
  newBatch: boolean,
): void {
  const sql = `SELECT chat_id,length(CAST(full_text AS BLOB)) bytes FROM assistant_delivery_batches
    UNION ALL SELECT chat_id,length(CAST(text AS BLOB))+COALESCE(length(CAST(markup AS BLOB)),0) FROM assistant_delivery_parts`;
  if (bytes <= DELIVERY_LIMITS.maxReplyBytes) {
    for (let pruned = 0; pruned <= DELIVERY_LIMITS.maxChatBatches; pruned++) {
      const chat = store.db
        .query(
          `SELECT COALESCE(SUM(bytes),0) bytes FROM (${sql}) WHERE chat_id=?`,
        )
        .get(chatId) as { bytes: number };
      const total = store.db
        .query(`SELECT COALESCE(SUM(bytes),0) bytes FROM (${sql})`)
        .get() as { bytes: number };
      const counts = store.db
        .query(
          'SELECT COUNT(*) total,SUM(chat_id=?) chat FROM assistant_delivery_batches',
        )
        .get(chatId) as { total: number; chat: number | null };
      const chatFull =
        chat.bytes + bytes > DELIVERY_LIMITS.maxChatTextBytes ||
        (newBatch && (counts.chat || 0) >= DELIVERY_LIMITS.maxChatBatches);
      const totalFull =
        total.bytes + bytes > DELIVERY_LIMITS.maxTotalTextBytes ||
        (newBatch && counts.total >= DELIVERY_LIMITS.maxTotalBatches);
      if (!chatFull && !totalFull) return;
      // Successful/cancelled records may expire early under pressure. Never evict unresolved payloads.
      const candidate = store.db
        .query(
          `SELECT b.id,b.run_id FROM assistant_delivery_batches b WHERE (?=0 OR b.chat_id=?)
        AND EXISTS (SELECT 1 FROM assistant_delivery_parts p WHERE p.batch_id=b.id)
        AND NOT EXISTS (SELECT 1 FROM assistant_delivery_parts p WHERE p.batch_id=b.id AND p.status NOT IN ('sent','cancelled'))
        AND NOT EXISTS (SELECT 1 FROM assistant_outbox o JOIN assistant_delivery_parts p ON p.id=o.id WHERE p.batch_id=b.id)
        ORDER BY b.created_at,b.rowid LIMIT 1`,
        )
        .get(chatFull ? 1 : 0, chatId) as {
        id: string;
        run_id: string | null;
      } | null;
      if (!candidate || pruned === DELIVERY_LIMITS.maxChatBatches) break;
      removeSnapshot(store, candidate, Date.now());
    }
  }
  throw new Error(
    'Достигнут лимит сохранённых доставок. Снимки хранятся до 7 дней.',
  );
}

export function snapshotBatch(
  store: AssistantStore,
  chatId: string,
  key: string,
  origin: DeliveryOrigin = {},
  fullText?: string,
): DeliveryBatch {
  expireDeliverySnapshots(store);
  const sourceKey = origin.runId ? `run:${origin.runId}` : key;
  const id =
    'delivery-' +
    createHash('sha256')
      .update(chatId + '\0' + sourceKey)
      .digest('hex')
      .slice(0, 16);
  const prior = deliveryBatch(store, chatId, id);
  if (
    prior?.full_text !== null &&
    prior?.full_text !== undefined &&
    fullText !== undefined &&
    prior.full_text !== fullText
  )
    throw new Error('Сохранённый ответ доставки неизменяем.');
  if (!prior || (fullText !== undefined && prior.full_text === null)) {
    reserveText(store, chatId, Buffer.byteLength(fullText || ''), !prior);
    const now = Date.now();
    store.db
      .query(
        'INSERT OR IGNORE INTO assistant_delivery_batches(id,chat_id,source_key,owner_id,run_id,full_text,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        chatId,
        sourceKey,
        origin.ownerId || null,
        origin.runId || null,
        fullText ?? null,
        now,
        now + DELIVERY_RETENTION_MS,
      );
    if (fullText !== undefined)
      store.db
        .query(
          'UPDATE assistant_delivery_batches SET full_text=? WHERE id=? AND full_text IS NULL',
        )
        .run(fullText, id);
  }
  return deliveryBatch(store, chatId, id)!;
}

export function snapshotPart(
  store: AssistantStore,
  batch: DeliveryBatch,
  row: { id: string; text: string; markup?: string | null },
  kind: 'text' | 'document',
  origin: DeliveryOrigin = {},
): DeliveryPart {
  const existing = deliveryPart(store, row.id);
  if (existing) {
    if (
      existing.batch_id !== batch.id ||
      existing.kind !== kind ||
      existing.text !== row.text ||
      existing.markup !== (row.markup ?? null)
    )
      throw new Error('Снимок части доставки неизменяем.');
    return existing;
  }
  reserveText(
    store,
    batch.chat_id,
    Buffer.byteLength(row.text) + Buffer.byteLength(row.markup || ''),
    false,
  );
  const count = store.db
    .query('SELECT COUNT(*) n FROM assistant_delivery_parts WHERE batch_id=?')
    .get(batch.id) as { n: number };
  if (count.n >= DELIVERY_LIMITS.maxBatchParts)
    throw new Error('Слишком много частей в одной доставке.');
  store.db
    .query(
      'INSERT INTO assistant_delivery_parts(id,batch_id,chat_id,kind,ordinal,text,markup,thread_id,message_id) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      row.id,
      batch.id,
      batch.chat_id,
      kind,
      count.n,
      row.text,
      row.markup ?? null,
      origin.threadId ?? null,
      origin.messageId ?? null,
    );
  return deliveryPart(store, row.id)!;
}

// Existing outbox rows from an earlier release get a snapshot before the first API call.
export function captureOutbox(
  store: AssistantStore,
  row: { id: string; chat_id: string; text: string; markup: string | null },
  kind: 'text' | 'document',
): DeliveryPart {
  const existing = deliveryPart(store, row.id);
  if (existing) return existing;
  const runId = store.state(`delivery_run:${row.id}`);
  const run = runId
    ? (store.db
        .query('SELECT user_id FROM assistant_runs WHERE id=? AND chat_id=?')
        .get(runId, row.chat_id) as { user_id: string | null } | null)
    : null;
  const job = /^(invite|nudge):/.test(row.id)
    ? store.job(row.id.slice(row.id.indexOf(':') + 1))
    : null;
  const target =
    kind === 'text' &&
    store.db
      .query(
        "SELECT 1 FROM sqlite_master WHERE name='assistant_text_deliveries'",
      )
      .get()
      ? (store.db
          .query(
            'SELECT thread_id,message_id FROM assistant_text_deliveries WHERE id=? AND chat_id=?',
          )
          .get(row.id, row.chat_id) as {
          thread_id: number | null;
          message_id: number | null;
        } | null)
      : null;
  const origin = {
    runId,
    ownerId:
      run?.user_id ?? (job?.chat_id === row.chat_id ? job.owner_id : undefined),
    threadId: target?.thread_id ?? undefined,
    messageId: target?.message_id ?? undefined,
  };
  const batch = snapshotBatch(store, row.chat_id, row.id, origin);
  return snapshotPart(store, batch, row, kind, origin);
}

export function setDeliveryStatus(
  store: AssistantStore,
  id: string,
  status: DeliveryStatus,
  messageId?: number,
): void {
  store.db
    .query(
      `UPDATE assistant_delivery_parts SET status=?,finished_at=?,
    attempts=attempts+CASE WHEN ?='sending' THEN 1 ELSE 0 END,
    uncertain_count=uncertain_count+CASE WHEN ?='uncertain' AND status!='uncertain' THEN 1 ELSE 0 END,
    message_id=COALESCE(?,message_id) WHERE id=? AND status!='cancelled'`,
    )
    .run(
      status,
      status === 'pending' || status === 'sending'
        ? null
        : new Date().toISOString(),
      status,
      status,
      messageId ?? null,
      id,
    );
}

export function stopBatchDeliveries(
  store: AssistantStore,
  batchId: string,
  exceptId: string,
  cancelled = false,
): void {
  for (const part of batchParts(store, batchId)) {
    if (
      part.id === exceptId ||
      part.status === 'sent' ||
      part.status === 'cancelled'
    )
      continue;
    const status = cancelled
      ? 'cancelled'
      : part.status === 'pending'
        ? 'blocked'
        : part.status;
    setDeliveryStatus(store, part.id, status);
    store.db
      .query(
        'UPDATE assistant_file_deliveries SET status=?,content=CASE WHEN ? THEN NULL ELSE content END,finished_at=? WHERE id=?',
      )
      .run(status, cancelled ? 1 : 0, new Date().toISOString(), part.id);
    store.db.query('DELETE FROM assistant_outbox WHERE id=?').run(part.id);
  }
}

export function cancelDeliverySnapshots(
  store: AssistantStore,
  chatId: string,
): void {
  const batches = store.db
    .query(
      'SELECT id FROM assistant_delivery_batches WHERE chat_id=? AND owner_id IS NOT NULL AND (run_id IS NULL OR run_id IN (SELECT id FROM assistant_runs WHERE user_id IS NOT NULL))',
    )
    .all(chatId) as { id: string }[];
  for (const batch of batches) {
    stopBatchDeliveries(store, batch.id, '', true);
    store.db
      .query('UPDATE assistant_delivery_batches SET full_text=NULL WHERE id=?')
      .run(batch.id);
    store.db
      .query(
        "UPDATE assistant_delivery_parts SET text='',markup=NULL WHERE batch_id=?",
      )
      .run(batch.id);
  }
}

export function cancelRunSnapshots(store: AssistantStore, runId: string): void {
  const batches = store.db
    .query('SELECT id FROM assistant_delivery_batches WHERE run_id=?')
    .all(runId) as { id: string }[];
  for (const batch of batches) stopBatchDeliveries(store, batch.id, '', true);
  if (
    store.db
      .query("SELECT 1 FROM sqlite_master WHERE name='assistant_prompt_runs'")
      .get()
  )
    store.db
      .query(
        "UPDATE assistant_prompt_runs SET status='cancelled',finished_at=? WHERE id=? AND status='awaiting_delivery'",
      )
      .run(new Date().toISOString(), runId);
}
