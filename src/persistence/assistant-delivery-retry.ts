import type { AssistantStore } from './assistant-store.js';
import {
  batchParts,
  deliveryBatch,
  expireDeliverySnapshots,
  type DeliveryPart,
} from './assistant-delivery-ledger.js';
import { textTarget } from './assistant-text-outbox.js';

export class DeliveryRetryConfirmation extends Error {}

export function retryDelivery(
  store: AssistantStore,
  chatId: string,
  ownerId: string,
  id: string,
  confirmDuplicate = false,
): string | null {
  expireDeliverySnapshots(store);
  return store.transaction(() => {
    const batch = deliveryBatch(store, chatId, id);
    if (!batch)
      throw new Error(
        'Доставка не найдена в этом чате или срок хранения истёк.',
      );
    if (
      batch.owner_id
        ? batch.owner_id !== ownerId
        : store.chat(chatId)?.type !== 'private' || chatId !== ownerId
    )
      throw new Error('Повторить доставку может автор исходного запроса.');
    if (!store.chat(chatId)?.active) throw new Error('Чат недоступен.');
    const job = batch.run_id
      ? (store.db
          .query(
            'SELECT j.status FROM assistant_jobs j JOIN assistant_job_deliveries d ON d.job_id=j.id WHERE d.run_id=?',
          )
          .get(batch.run_id) as { status: string } | null)
      : null;
    if (job?.status === 'cancelled')
      throw new Error('Задача отменена; повторная доставка запрещена.');
    const prompt = batch.run_id
      ? (store.db
          .query(
            'SELECT j.status,j.revision,r.revision AS run_revision FROM assistant_prompt_jobs j JOIN assistant_prompt_runs r ON r.job_id=j.id WHERE r.id=? AND j.chat_id=?',
          )
          .get(batch.run_id, chatId) as {
          status: string;
          revision: number;
          run_revision: number;
        } | null)
      : null;
    if (
      prompt &&
      (prompt.status !== 'active' || prompt.revision !== prompt.run_revision)
    )
      throw new Error(
        'Периодическое поручение изменено, приостановлено или отменено; повтор запрещён.',
      );
    const parts = batchParts(store, id);
    if (
      parts.some(
        (part) => part.status === 'pending' || part.status === 'sending',
      )
    )
      throw new Error('Доставка ещё идёт. Посмотрите /delivery ' + id + '.');
    const retry = parts.filter((part) =>
      ['uncertain', 'failed', 'blocked'].includes(part.status),
    );
    if (!retry.length) throw new Error('Нет частей для повторной доставки.');
    if (retry.some((part) => part.uncertain_count > 0) && !confirmDuplicate)
      throw new DeliveryRetryConfirmation(
        'Telegram мог уже доставить сообщение или файл. Повтор может создать дубликат. Для явного повтора: /retry_delivery ' +
          id +
          ' confirm',
      );
    // Validate all immutable payloads before restoring any queue entry.
    for (const part of retry) {
      if (
        part.kind === 'document' &&
        !store.db
          .query(
            'SELECT id FROM assistant_file_deliveries WHERE id=? AND chat_id=? AND content IS NOT NULL',
          )
          .get(part.id, chatId)
      )
        throw new Error('Снимок документа недоступен; повтор остановлен.');
    }
    for (const part of retry) restorePart(store, part, batch.run_id);
    if (batch.run_id) {
      store.db
        .query(
          "UPDATE assistant_runs SET status='running',finished_at=NULL WHERE id=? AND status='error'",
        )
        .run(batch.run_id);
      store.db
        .query(
          "UPDATE assistant_prompt_runs SET status='awaiting_delivery' WHERE id=? AND status='delivery_failed'",
        )
        .run(batch.run_id);
      store.db
        .query(
          "UPDATE assistant_jobs SET status='delivering' WHERE status='delivery_failed' AND id IN (SELECT job_id FROM assistant_job_deliveries WHERE run_id=?)",
        )
        .run(batch.run_id);
    }
    return batch.run_id;
  });
}

function restorePart(
  store: AssistantStore,
  part: DeliveryPart,
  runId: string | null,
): void {
  if (part.kind === 'document') {
    store.db
      .query(
        "UPDATE assistant_file_deliveries SET status='pending',finished_at=NULL WHERE id=? AND chat_id=?",
      )
      .run(part.id, part.chat_id);
  } else {
    textTarget(store, part.id, part.chat_id, {
      messageId: part.message_id ?? undefined,
      threadId: part.thread_id ?? undefined,
    });
    store.db
      .query(
        "UPDATE assistant_text_deliveries SET status='pending',finished_at=NULL,message_id=? WHERE id=? AND chat_id=?",
      )
      .run(part.message_id, part.id, part.chat_id);
  }
  store.db
    .query(
      "UPDATE assistant_delivery_parts SET status='pending',finished_at=NULL WHERE id=?",
    )
    .run(part.id);
  store.send(
    part.id,
    part.chat_id,
    part.text,
    part.markup ? JSON.parse(part.markup) : undefined,
  );
  if (runId) store.setState(`delivery_run:${part.id}`, runId);
}
