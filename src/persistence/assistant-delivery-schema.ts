// Delivery snapshots are independent of bounded conversation history and mutable VFS files.
export const ASSISTANT_DELIVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS assistant_delivery_batches (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, source_key TEXT NOT NULL,
  owner_id TEXT, run_id TEXT, full_text TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  UNIQUE(chat_id,source_key)
);
CREATE INDEX IF NOT EXISTS assistant_delivery_batch_chat ON assistant_delivery_batches(chat_id,created_at);
CREATE TABLE IF NOT EXISTS assistant_delivery_parts (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, chat_id TEXT NOT NULL,
  kind TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, markup TEXT,
  thread_id INTEGER, message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  uncertain_count INTEGER NOT NULL DEFAULT 0, finished_at TEXT,
  UNIQUE(batch_id,ordinal)
);
CREATE INDEX IF NOT EXISTS assistant_delivery_part_batch ON assistant_delivery_parts(batch_id,ordinal);
`;

export const DELIVERY_RETENTION_MS = 7 * 86400_000;
export const DELIVERY_LIMITS = {
  maxReplyBytes: 1024 * 1024,
  maxChatTextBytes: 8 * 1024 * 1024,
  maxTotalTextBytes: 128 * 1024 * 1024,
  maxChatBatches: 1000,
  maxTotalBatches: 20000,
  maxBatchParts: 256,
};
