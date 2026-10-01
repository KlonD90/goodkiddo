import type { AssistantStore } from './assistant-store.js';
import { cancelRunSnapshots } from './assistant-delivery-ledger.js';

// Shared text/document outbox cancellation. A companion document table is optional.
export function discardRunDeliveries(
  store: AssistantStore,
  runId: string,
): void {
  cancelRunSnapshots(store, runId);
  const rows = store.db
    .query(
      "SELECT key FROM assistant_state WHERE key LIKE 'delivery_run:%' AND value=?",
    )
    .all(runId) as { key: string }[];
  const hasDocuments = !!store.db
    .query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_file_deliveries'",
    )
    .get();
  for (const row of rows) {
    const id = row.key.slice('delivery_run:'.length);
    if (hasDocuments)
      store.db
        .query(
          "UPDATE assistant_file_deliveries SET content=NULL,status='cancelled',finished_at=? WHERE id=? AND status='pending'",
        )
        .run(new Date().toISOString(), id);
    store.db.query('DELETE FROM assistant_outbox WHERE id=?').run(id);
    store.db.query('DELETE FROM assistant_state WHERE key=?').run(row.key);
  }
  store.db
    .query('DELETE FROM assistant_state WHERE key=?')
    .run(`delivery_hold:${runId}`);
}
