import type { AssistantStore } from './assistant-store.js';
import {
  captureOutbox,
  setDeliveryStatus,
} from './assistant-delivery-ledger.js';
import {
  UncertainDelivery,
  ambiguousTelegramSend,
} from '../channels/telegram-delivery-outcome.js';
import type { TelegramAssistantApi } from '../channels/telegram-assistant-api.js';

export class UncertainTextDelivery extends UncertainDelivery {
  constructor() {
    super('final message');
  }
}
export interface TextTarget {
  threadId?: number;
  messageId?: number;
  runId?: string;
  ownerId?: string;
}
interface DeliveryState {
  id: string;
  chat_id: string;
  thread_id: number | null;
  message_id: number | null;
  status: string;
}
export function ensureTextDeliverySchema(store: AssistantStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_reply_previews (
      run_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, thread_id INTEGER,
      message_id INTEGER, status TEXT NOT NULL DEFAULT 'creating'
    );
    CREATE TABLE IF NOT EXISTS assistant_text_deliveries (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, thread_id INTEGER,
      message_id INTEGER, status TEXT NOT NULL DEFAULT 'pending',
      finished_at TEXT
    );
  `);
}
export function textTarget(
  store: AssistantStore,
  id: string,
  chatId: string,
  target: TextTarget = {},
): void {
  ensureTextDeliverySchema(store);
  store.db
    .query(
      'INSERT OR IGNORE INTO assistant_text_deliveries(id,chat_id,thread_id,message_id) VALUES (?,?,?,?)',
    )
    .run(id, chatId, target.threadId ?? null, target.messageId ?? null);
}
export async function deliverText(
  store: AssistantStore,
  api: TelegramAssistantApi,
  row: { id: string; chat_id: string; text: string; markup: string | null },
): Promise<void> {
  const snapshot = captureOutbox(store, row, 'text');
  textTarget(store, row.id, row.chat_id);
  const state = store.db
    .query('SELECT * FROM assistant_text_deliveries WHERE id=? AND chat_id=?')
    .get(row.id, row.chat_id) as DeliveryState | null;
  if (!state) throw new Error('Missing text delivery state');
  if (state.status === 'sent' || snapshot.status === 'sent') {
    setDeliveryStatus(store, row.id, 'sent', state.message_id ?? undefined);
    return;
  }
  // Sending to an existing message is idempotent. A new send has no Bot API idempotency key.
  if (
    state.status === 'uncertain' ||
    snapshot.status === 'uncertain' ||
    (state.status === 'sending' && !state.message_id)
  ) {
    store.db
      .query(
        "UPDATE assistant_text_deliveries SET status='uncertain',finished_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), row.id);
    setDeliveryStatus(store, row.id, 'uncertain');
    throw new UncertainTextDelivery();
  }
  store.db
    .query("UPDATE assistant_text_deliveries SET status='sending' WHERE id=?")
    .run(row.id);
  setDeliveryStatus(store, row.id, 'sending');
  try {
    const markup = row.markup ? JSON.parse(row.markup) : undefined;
    let messageId: number | undefined;
    if (state.message_id) {
      await api.editRich(row.chat_id, state.message_id, row.text, markup);
      messageId = state.message_id;
    } else
      messageId = await api.send(
        row.chat_id,
        row.text,
        markup,
        state.thread_id ?? undefined,
      );
    store.db
      .query(
        "UPDATE assistant_text_deliveries SET status='sent',finished_at=?,message_id=COALESCE(?,message_id) WHERE id=?",
      )
      .run(new Date().toISOString(), messageId ?? null, row.id);
    setDeliveryStatus(store, row.id, 'sent', messageId);
  } catch (error) {
    const ambiguous = ambiguousTelegramSend(error);
    if (ambiguous && !state.message_id) {
      store.db
        .query(
          "UPDATE assistant_text_deliveries SET status='uncertain',finished_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), row.id);
      setDeliveryStatus(store, row.id, 'uncertain');
      throw new UncertainTextDelivery();
    }
    store.db
      .query("UPDATE assistant_text_deliveries SET status='pending' WHERE id=?")
      .run(row.id);
    setDeliveryStatus(store, row.id, 'pending');
    throw error;
  }
}
