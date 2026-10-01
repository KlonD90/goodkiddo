import type { AssistantStore } from '../persistence/assistant-store.js';
import type { AssistantJob } from '../shared/assistant-types.js';
import { discardRunDeliveries } from '../persistence/assistant-delivery-links.js';
import { enqueueReply } from '../assistant/messages.js';
import { retryDelivery } from '../persistence/assistant-delivery-retry.js';

export function queueJobDelivery(
  store: AssistantStore,
  job: AssistantJob,
  text: string,
): string {
  return store.transaction(() => {
    const attempt =
      (
        store.db
          .query(
            'SELECT COALESCE(MAX(attempt),0) AS n FROM assistant_job_deliveries WHERE job_id=?',
          )
          .get(job.id) as { n: number }
      ).n + 1;
    const runId = `scheduled:${job.id}:${attempt}`;
    store.db
      .query('INSERT INTO assistant_job_deliveries VALUES (?,?,?,?)')
      .run(runId, job.id, text, attempt);
    store.startRun(runId, store.chat(job.chat_id)!, null, job.kind);
    const deliveries = enqueueReply(
      store,
      `due:${job.id}:${attempt}`,
      job.chat_id,
      text,
      { runId, ownerId: job.owner_id },
    );
    for (const id of deliveries) store.setState(`delivery_run:${id}`, runId);
    store.finishJob(job.id, 'delivering');
    return runId;
  });
}
export function finishScheduledDelivery(
  store: AssistantStore,
  runId: string,
  status: 'success' | 'error' | 'cancelled',
): void {
  const delivery = store.db
    .query('SELECT job_id FROM assistant_job_deliveries WHERE run_id=?')
    .get(runId) as { job_id: string } | null;
  if (!delivery) return;
  const job = store.job(delivery.job_id);
  if (job?.status === 'delivering')
    store.finishJob(
      job.id,
      status === 'success'
        ? 'completed'
        : status === 'error'
          ? 'delivery_failed'
          : 'cancelled',
    );
}
export function retryJobDelivery(
  store: AssistantStore,
  chatId: string,
  ownerId: string,
  id: string,
  confirmDuplicate = false,
): string {
  const job = store.job(id);
  if (!job || job.chat_id !== chatId)
    throw new Error('Задача не найдена в этом чате.');
  if (job.owner_id !== ownerId)
    throw new Error('Повторить доставку может её создатель.');
  if (job.status !== 'delivery_failed')
    throw new Error('Доставка этой задачи не завершилась ошибкой.');
  if (!store.chat(chatId)?.active) throw new Error('Чат недоступен.');
  const batch = store.db
    .query(
      'SELECT b.id FROM assistant_delivery_batches b JOIN assistant_job_deliveries d ON d.run_id=b.run_id WHERE d.job_id=? AND b.chat_id=? ORDER BY d.attempt DESC LIMIT 1',
    )
    .get(id, chatId) as { id: string } | null;
  if (batch) {
    return retryDelivery(store, chatId, ownerId, batch.id, confirmDuplicate)!;
  }
  const previous = store.db
    .query(
      'SELECT text FROM assistant_job_deliveries WHERE job_id=? ORDER BY attempt DESC LIMIT 1',
    )
    .get(job.id) as { text: string } | null;
  if (!previous) throw new Error('Сохранённый результат доставки не найден.');
  return queueJobDelivery(store, job, previous.text);
}
export function cancelJobDelivery(
  store: AssistantStore,
  job: AssistantJob,
): void {
  store.transaction(() => {
    const deliveries = store.db
      .query('SELECT run_id FROM assistant_job_deliveries WHERE job_id=?')
      .all(job.id) as { run_id: string }[];
    for (const delivery of deliveries) {
      discardRunDeliveries(store, delivery.run_id);
      store.db
        .query(
          "UPDATE assistant_runs SET status='cancelled',finished_at=? WHERE id=? AND status='running'",
        )
        .run(new Date().toISOString(), delivery.run_id);
    }
    store.db
      .query('DELETE FROM assistant_outbox WHERE id IN (?,?)')
      .run(`nudge:${job.id}`, `invite:${job.id}`);
    store.finishJob(job.id, 'cancelled');
  });
}
