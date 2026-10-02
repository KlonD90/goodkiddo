export const ASSISTANT_PAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS assistant_mini_pages (
  id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, source_path TEXT NOT NULL, title TEXT NOT NULL,
  content BLOB NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_mini_pages_chat ON assistant_mini_pages(chat_id, expires_at);
CREATE TABLE IF NOT EXISTS assistant_mini_page_assets (
  page_id TEXT NOT NULL, chat_id TEXT NOT NULL, path TEXT NOT NULL,
  mime_type TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(page_id,path)
);
CREATE TABLE IF NOT EXISTS assistant_file_page_previews (
  token_hash TEXT NOT NULL, ordinal INTEGER NOT NULL, page_id TEXT NOT NULL,
  PRIMARY KEY(token_hash,ordinal)
);
`;
