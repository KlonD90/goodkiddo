export const ASSISTANT_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS assistant_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_chats (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, timezone TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS assistant_inbox (
  id INTEGER PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS assistant_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_history_chat ON assistant_history(chat_id, id);
CREATE TABLE IF NOT EXISTS assistant_jobs (
  id TEXT PRIMARY KEY, origin_key TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, due_at TEXT NOT NULL, remind_at TEXT,
  reminded INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_jobs_due ON assistant_jobs(status, due_at);
CREATE TABLE IF NOT EXISTS assistant_votes (
  job_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, name TEXT NOT NULL, choices TEXT NOT NULL,
  PRIMARY KEY(job_id, user_id)
);
CREATE TABLE IF NOT EXISTS assistant_outbox (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, text TEXT NOT NULL, markup TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_runs (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT, task_type TEXT NOT NULL,
  used_search INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, finished_at TEXT,
  llm_calls INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS assistant_runs_limits ON assistant_runs(started_at, chat_id, user_id);
CREATE TABLE IF NOT EXISTS assistant_spend (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, cost_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assistant_files (
  chat_id TEXT NOT NULL, path TEXT NOT NULL, content BLOB NOT NULL,
  mime_type TEXT NOT NULL, origin_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  source_date TEXT,
  PRIMARY KEY(chat_id,path), UNIQUE(chat_id,origin_id)
);
CREATE TABLE IF NOT EXISTS assistant_file_deliveries (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, path TEXT NOT NULL,
  filename TEXT NOT NULL, mime_type TEXT NOT NULL, content BLOB,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TRIGGER IF NOT EXISTS assistant_file_delivery_cleanup AFTER DELETE ON assistant_outbox
BEGIN
  UPDATE assistant_file_deliveries SET content=NULL,status='cancelled',finished_at=datetime('now')
  WHERE id=OLD.id AND status='pending';
END;
CREATE TABLE IF NOT EXISTS assistant_file_grants (
  token_hash TEXT PRIMARY KEY, chat_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_file_grant_items (
  token_hash TEXT NOT NULL, chat_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  path TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, content BLOB NOT NULL,
  PRIMARY KEY(token_hash,ordinal)
);
`;
