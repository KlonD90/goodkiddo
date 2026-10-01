import type { AssistantStore } from '../persistence/assistant-store.js';
import {
  batchParts,
  deliveryBatch,
  expireDeliverySnapshots,
  type DeliveryBatch,
} from '../persistence/assistant-delivery-ledger.js';

export function deliveryStatus(
  store: AssistantStore,
  chatId: string,
  id?: string,
) {
  expireDeliverySnapshots(store);
  const batches = id
    ? [deliveryBatch(store, chatId, id)].filter((b): b is DeliveryBatch => !!b)
    : (store.db
        .query(
          "SELECT * FROM assistant_delivery_batches WHERE chat_id=? AND source_key NOT LIKE 'command:%' ORDER BY created_at DESC,rowid DESC LIMIT 10",
        )
        .all(chatId) as DeliveryBatch[]);
  if (id && !batches.length)
    throw new Error('Доставка не найдена в этом чате или срок хранения истёк.');
  return batches.map((batch) => {
    const parts = batchParts(store, batch.id);
    return {
      id: batch.id,
      created_at: new Date(batch.created_at).toISOString(),
      expires_at: new Date(batch.expires_at).toISOString(),
      counts: Object.fromEntries(
        [
          'pending',
          'sending',
          'sent',
          'uncertain',
          'failed',
          'blocked',
          'cancelled',
        ].map((status) => [
          status,
          parts.filter((part) => part.status === status).length,
        ]),
      ),
      possible_duplicate: parts.some((part) => part.uncertain_count > 0),
      parts: id
        ? parts.map((part) => ({
            part: part.ordinal + 1,
            kind: part.kind,
            status: part.status,
            attempts: part.attempts,
            possible_duplicate: part.uncertain_count > 0,
          }))
        : undefined,
    };
  });
}
const labels: Record<string, string> = {
  pending: 'в очереди',
  sending: 'отправляется',
  sent: 'подтверждено Telegram',
  uncertain: 'результат неизвестен',
  failed: 'отклонено',
  blocked: 'ещё не отправлено',
  cancelled: 'отменено',
};
export function deliveryStatusText(
  store: AssistantStore,
  chatId: string,
  id?: string,
): string {
  const deliveries = deliveryStatus(store, chatId, id);
  if (!deliveries.length) return 'Сохранённых доставок пока нет.';
  return deliveries
    .map(
      (delivery) =>
        `${delivery.id}\n` +
        Object.entries(delivery.counts)
          .filter(([, count]) => count)
          .map(([status, count]) => `${labels[status]}: ${count}`)
          .join(' · ') +
        (delivery.possible_duplicate
          ? '\nTelegram мог уже принять часть отправки. Повтор может создать дубликат.'
          : '') +
        (delivery.parts
          ? '\n' +
            delivery.parts
              .map(
                (part) =>
                  `${part.part}. ${part.kind === 'document' ? 'Документ' : 'Текст'}: ${labels[part.status]}`,
              )
              .join('\n')
          : '') +
        `\nХранение до ${delivery.expires_at}\nПодробнее: /delivery ${delivery.id}\nПовтор недоставленных частей: /retry_delivery ${delivery.id}`,
    )
    .join('\n\n');
}
