import { createHash } from 'node:crypto';
import type { AssistantStore } from './assistant-store.js';
import { AssistantFiles } from './assistant-files.js';
import { AssistantFileError, documentName } from './assistant-file-policy.js';
import { checkFileQuota } from './assistant-file-quota.js';
import {
  expireDeliverySnapshots,
  snapshotBatch,
  snapshotPart,
  type DeliveryOrigin,
} from './assistant-delivery-ledger.js';

export interface DocumentDelivery {
  id: string;
  chat_id: string;
  filename: string;
  mime_type: string;
  content: Uint8Array | null;
  status:
    | 'pending'
    | 'sending'
    | 'uncertain'
    | 'blocked'
    | 'sent'
    | 'error'
    | 'cancelled'
    | 'expired';
}

export function queueDocument(
  store: AssistantStore,
  files: AssistantFiles,
  chatId: string,
  filePath: string,
  caption: string,
  taskId: string,
  origin: DeliveryOrigin = {},
) {
  if (caption.length > 1024)
    throw new AssistantFileError(
      'Подпись документа ограничена 1024 символами.',
    );
  return store.transaction(() => {
    expireDeliverySnapshots(store);
    const file = files.get(chatId, filePath);
    if (!file.content.length)
      throw new AssistantFileError('Пустой файл нельзя отправить документом.');
    const id =
      'document:' +
      createHash('sha256')
        .update(
          chatId + '\0' + taskId + '\0' + file.path + '\0' + caption + '\0',
        )
        .update(file.content)
        .digest('hex');
    const existing = store.db
      .query(
        'SELECT status FROM assistant_file_deliveries WHERE id=? AND chat_id=?',
      )
      .get(id, chatId) as { status: string } | null;
    if (existing)
      return {
        id,
        path: file.path,
        status: existing.status === 'pending' ? 'queued' : existing.status,
      };
    const count = store.db
      .query(
        'SELECT COUNT(*) AS n FROM assistant_file_deliveries WHERE chat_id=? AND content IS NOT NULL',
      )
      .get(chatId) as { n: number };
    if (count.n >= 100)
      throw new AssistantFileError('В этом чате очередь документов заполнена.');
    checkFileQuota(store.db, files.limits, chatId, file.content.length);
    const run = store.db
      .query('SELECT user_id FROM assistant_runs WHERE id=? AND chat_id=?')
      .get(taskId, chatId) as { user_id: string | null } | null;
    const target = {
      ...origin,
      runId: taskId,
      ownerId: origin.ownerId || run?.user_id || undefined,
    };
    const batch = snapshotBatch(store, chatId, id, target);
    snapshotPart(store, batch, { id, text: caption }, 'document', target);
    store.db
      .query(
        'INSERT INTO assistant_file_deliveries(id,chat_id,path,filename,mime_type,content,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        id,
        chatId,
        file.path,
        documentName(file.path),
        file.mime_type,
        file.content,
        new Date().toISOString(),
      );
    store.send(id, chatId, caption);
    store.setState(`delivery_run:${id}`, taskId);
    return { id, path: file.path, status: 'queued' };
  });
}

export function documentDelivery(
  store: AssistantStore,
  id: string,
  chatId: string,
): DocumentDelivery | null {
  return store.db
    .query(
      'SELECT id,chat_id,filename,mime_type,content,status FROM assistant_file_deliveries WHERE id=? AND chat_id=?',
    )
    .get(id, chatId) as DocumentDelivery | null;
}

export function finishDocument(
  store: AssistantStore,
  id: string,
  status: 'sent' | 'error' | 'cancelled',
): void {
  store.db
    .query(
      "UPDATE assistant_file_deliveries SET content=CASE WHEN ? IN ('sent','cancelled') THEN NULL ELSE content END,status=?,finished_at=? WHERE id=? AND status NOT IN ('sent','cancelled','expired')",
    )
    .run(status, status, new Date().toISOString(), id);
}
