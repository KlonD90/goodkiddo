export const ASSISTANT_PAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS assistant_mini_pages (
  id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, source_path TEXT NOT NULL, title TEXT NOT NULL,
  content BLOB NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_mini_pages_chat ON assistant_mini_pages(chat_id, expires_at);
`;
