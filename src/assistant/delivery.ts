import {
  TelegramApiError,
  type TelegramAssistantApi,
} from '../channels/telegram-assistant-api.js';
import type { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import type { AssistantStore } from '../persistence/assistant-store.js';
import {
  documentDelivery,
  finishDocument,
} from '../persistence/assistant-document-outbox.js';
import { finishScheduledDelivery } from '../tasks/assistant-job-delivery.js';
import { deliverText } from '../persistence/assistant-text-outbox.js';
import { UncertainDelivery } from '../channels/telegram-delivery-outcome.js';
import { deliverDocument } from './document-delivery.js';
import {
  captureOutbox,
  deliveryPart,
  expireDeliverySnapshots,
  setDeliveryStatus,
  stopBatchDeliveries,
} from '../persistence/assistant-delivery-ledger.js';

interface OutboxMessage {
  id: string;
  chat_id: string;
  text: string;
  markup: string | null;
  attempts: number;
}
const activeDeliveries = new WeakMap<AssistantStore, Promise<void>>();
export async function deliverMessages(
  store: AssistantStore,
  api: TelegramAssistantApi,
  analytics: AssistantAnalytics,
): Promise<void> {
  const active = activeDeliveries.get(store);
  if (active) return active;
  const work = drainMessages(store, api, analytics).finally(() =>
    activeDeliveries.delete(store),
  );
  activeDeliveries.set(store, work);
  return work;
}
async function drainMessages(
  store: AssistantStore,
  api: TelegramAssistantApi,
  analytics: AssistantAnalytics,
): Promise<void> {
  expireDeliverySnapshots(store);
  const rows = store.db
    .query(
      `SELECT o.* FROM assistant_outbox o WHERE o.next_attempt<=? AND NOT EXISTS (SELECT 1 FROM assistant_outbox earlier WHERE earlier.chat_id=o.chat_id AND earlier.rowid<o.rowid)
      AND NOT EXISTS (SELECT 1 FROM assistant_state link JOIN assistant_state hold ON hold.key='delivery_hold:'||link.value WHERE link.key='delivery_run:'||o.id)
      ORDER BY o.rowid LIMIT 20`,
    )
    .all(new Date().toISOString()) as OutboxMessage[];
  for (const row of rows) {
    // /clear or cancellation can remove a later row while an earlier API call is in flight.
    if (
      !store.db.query('SELECT id FROM assistant_outbox WHERE id=?').get(row.id)
    )
      continue;
    const chat = store.chat(row.chat_id);
    const document = documentDelivery(store, row.id, row.chat_id);
    const snapshot = captureOutbox(store, row, document ? 'document' : 'text');
    if (!chat?.active) {
      setDeliveryStatus(store, row.id, 'cancelled');
      stopBatchDeliveries(store, snapshot.batch_id, row.id, true);
      finishDocument(store, row.id, 'cancelled');
      finishDelivery(store, analytics, row, 'cancelled');
      store.db.query('DELETE FROM assistant_outbox WHERE id=?').run(row.id);
      continue;
    }
    try {
      if (document) {
        await deliverDocument(store, api, row);
      } else await deliverText(store, api, row);
      store.transaction(() => {
        finishDocument(store, row.id, 'sent');
        finishDelivery(store, analytics, row, 'success');
        store.db.query('DELETE FROM assistant_outbox WHERE id=?').run(row.id);
      });
    } catch (error) {
      if (error instanceof UncertainDelivery) {
        // Retain the uncertain receipt, release the chat queue, and never automatically resend.
        stopBatchDeliveries(store, snapshot.batch_id, row.id);
        finishDelivery(store, analytics, row, 'error');
        store.db.query('DELETE FROM assistant_outbox WHERE id=?').run(row.id);
      } else if (error instanceof TelegramApiError && error.code === 403) {
        store.saveChat({ ...chat, active: 0 });
        const pending = store.db
          .query('SELECT * FROM assistant_outbox WHERE chat_id=?')
          .all(chat.id) as OutboxMessage[];
        for (const message of pending) {
          const part = captureOutbox(
            store,
            message,
            documentDelivery(store, message.id, message.chat_id)
              ? 'document'
              : 'text',
          );
          setDeliveryStatus(
            store,
            message.id,
            message.id === row.id ? 'failed' : 'blocked',
          );
          stopBatchDeliveries(store, part.batch_id, message.id);
          // The rejected request and unattempted documents remain available for an explicit retry.
          store.db
            .query(
              'UPDATE assistant_file_deliveries SET status=? WHERE id=? AND content IS NOT NULL',
            )
            .run(message.id === row.id ? 'error' : 'blocked', message.id);
          finishDelivery(store, analytics, message, 'error');
        }
        store.db
          .query('DELETE FROM assistant_outbox WHERE chat_id=?')
          .run(chat.id);
        store.db
          .query(
            "UPDATE assistant_jobs SET status='cancelled' WHERE chat_id=? AND status IN ('active','delivering')",
          )
          .run(chat.id);
      } else if (
        error instanceof TelegramApiError &&
        error.code === 400 &&
        row.attempts >= 2
      ) {
        setDeliveryStatus(store, row.id, 'failed');
        stopBatchDeliveries(store, snapshot.batch_id, row.id);
        finishDocument(store, row.id, 'error');
        finishDelivery(store, analytics, row, 'error');
        store.db.query('DELETE FROM assistant_outbox WHERE id=?').run(row.id);
      } else {
        const delay =
          error instanceof TelegramApiError && error.retryAfter
            ? error.retryAfter * 1000
            : Math.min(3600_000, 2000 * 2 ** Math.min(row.attempts, 11));
        store.db
          .query(
            'UPDATE assistant_outbox SET attempts=attempts+1,next_attempt=? WHERE id=?',
          )
          .run(new Date(Date.now() + delay).toISOString(), row.id);
        // Respect flood control globally, preserving remaining entries for the next tick.
        if (error instanceof TelegramApiError && error.code === 429) break;
      }
    }
  }
}

function finishDelivery(
  store: AssistantStore,
  analytics: AssistantAnalytics,
  message: OutboxMessage,
  status: 'success' | 'error' | 'cancelled',
): void {
  const key = `delivery_run:${message.id}`;
  const runId = store.state(key);
  if (!runId) return;
  store.db.query('DELETE FROM assistant_state WHERE key=?').run(key);
  const remaining = store.db
    .query(
      "SELECT key FROM assistant_state WHERE key LIKE 'delivery_run:%' AND value=?",
    )
    .all(runId) as { key: string }[];
  if (status === 'success' && remaining.length) return;
  if (status !== 'success') {
    for (const row of remaining) {
      const id = row.key.slice('delivery_run:'.length);
      const queued = store.db
        .query('SELECT * FROM assistant_outbox WHERE id=?')
        .get(id) as OutboxMessage | null;
      if (queued) {
        const part = captureOutbox(
          store,
          queued,
          documentDelivery(store, id, queued.chat_id) ? 'document' : 'text',
        );
        setDeliveryStatus(
          store,
          id,
          status === 'cancelled' ? 'cancelled' : 'blocked',
        );
        stopBatchDeliveries(store, part.batch_id, '', status === 'cancelled');
        store.db
          .query(
            "UPDATE assistant_file_deliveries SET status=?,content=CASE WHEN ? THEN NULL ELSE content END WHERE id=? AND status NOT IN ('sent','cancelled')",
          )
          .run(
            status === 'cancelled' ? 'cancelled' : 'blocked',
            status === 'cancelled' ? 1 : 0,
            id,
          );
      }
      store.db
        .query('DELETE FROM assistant_outbox WHERE id=?')
        .run(row.key.slice('delivery_run:'.length));
      store.db.query('DELETE FROM assistant_state WHERE key=?').run(row.key);
    }
  }
  const chat = store.chat(message.chat_id);
  finishScheduledDelivery(store, runId, status);
  store.promptJobs.finishDelivery(runId, status);
  const run = store.db
    .query('SELECT user_id FROM assistant_runs WHERE id=?')
    .get(runId) as { user_id: string | null } | null;
  if (chat && run)
    analytics.finish(
      runId,
      chat,
      run.user_id,
      status,
      status === 'success' ? undefined : 'tool_error',
    );
}
