import type { AssistantStore } from '../persistence/assistant-store.js';
import { documentDelivery } from '../persistence/assistant-document-outbox.js';
import {
  captureOutbox,
  setDeliveryStatus,
} from '../persistence/assistant-delivery-ledger.js';
import {
  TelegramApiError,
  type TelegramAssistantApi,
} from '../channels/telegram-assistant-api.js';
import {
  UncertainDelivery,
  ambiguousTelegramSend,
} from '../channels/telegram-delivery-outcome.js';

export async function deliverDocument(
  store: AssistantStore,
  api: TelegramAssistantApi,
  row: { id: string; chat_id: string; text: string; markup: string | null },
): Promise<void> {
  const snapshot = captureOutbox(store, row, 'document');
  const document = documentDelivery(store, row.id, row.chat_id);
  if (snapshot.status === 'sent' || document?.status === 'sent') {
    setDeliveryStatus(store, row.id, 'sent');
    return;
  }
  if (
    snapshot.status === 'uncertain' ||
    snapshot.status === 'sending' ||
    document?.status === 'sending' ||
    document?.status === 'uncertain'
  ) {
    setDeliveryStatus(store, row.id, 'uncertain');
    store.db
      .query(
        "UPDATE assistant_file_deliveries SET status='uncertain' WHERE id=? AND status NOT IN ('cancelled','sent')",
      )
      .run(row.id);
    throw new UncertainDelivery('document');
  }
  if (!document?.content || document.status !== 'pending')
    throw new TelegramApiError(400);
  store.transaction(() => {
    setDeliveryStatus(store, row.id, 'sending');
    store.db
      .query("UPDATE assistant_file_deliveries SET status='sending' WHERE id=?")
      .run(row.id);
  });
  try {
    const messageId = await api.sendDocument(
      row.chat_id,
      {
        filename: document.filename,
        mime_type: document.mime_type,
        content: document.content,
      },
      snapshot.text,
      snapshot.thread_id ?? undefined,
    );
    setDeliveryStatus(store, row.id, 'sent', messageId);
  } catch (error) {
    const ambiguous = ambiguousTelegramSend(error);
    setDeliveryStatus(store, row.id, ambiguous ? 'uncertain' : 'pending');
    store.db
      .query(
        "UPDATE assistant_file_deliveries SET status=? WHERE id=? AND status NOT IN ('cancelled','sent')",
      )
      .run(ambiguous ? 'uncertain' : 'pending', row.id);
    if (ambiguous) throw new UncertainDelivery('document');
    throw error;
  }
}
