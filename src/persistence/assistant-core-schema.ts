// Companion tables keep capability upgrades independent of the transport/file schema.
export const ASSISTANT_CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS assistant_history_archive (
  id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_archive_chat ON assistant_history_archive(chat_id,id);
CREATE TABLE IF NOT EXISTS assistant_context_summaries (
  chat_id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_memories (
  chat_id TEXT NOT NULL, key TEXT NOT NULL, owner_id TEXT NOT NULL,
  kind TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(chat_id,key)
);
CREATE TABLE IF NOT EXISTS assistant_todos (
  id TEXT PRIMARY KEY, origin_key TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_todo_chat ON assistant_todos(chat_id,status,created_at);
CREATE TABLE IF NOT EXISTS assistant_job_deliveries (
  run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, text TEXT NOT NULL, attempt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_prompt_jobs (
  id TEXT PRIMARY KEY, origin_key TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  title TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT NOT NULL, timezone TEXT NOT NULL,
  notification TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', next_run TEXT NOT NULL,
  last_run TEXT, revision INTEGER NOT NULL DEFAULT 1, failures INTEGER NOT NULL DEFAULT 0,
  max_calls INTEGER NOT NULL, max_searches INTEGER NOT NULL, max_cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_prompt_due ON assistant_prompt_jobs(status,next_run);
CREATE TABLE IF NOT EXISTS assistant_prompt_runs (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, due_at TEXT NOT NULL, revision INTEGER NOT NULL,
  status TEXT NOT NULL, outcome TEXT, result TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE(job_id,due_at)
);
`;
