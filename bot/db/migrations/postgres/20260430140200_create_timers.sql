-- migrate:up
CREATE TABLE IF NOT EXISTS timers (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	chat_id TEXT NOT NULL,
	md_file_path TEXT NOT NULL,
	cron_expression TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'always',
	message TEXT,
	timezone TEXT NOT NULL DEFAULT 'UTC',
	enabled INTEGER NOT NULL DEFAULT 1,
	last_run_at BIGINT,
	last_error TEXT,
	consecutive_failures INTEGER NOT NULL DEFAULT 0,
	next_run_at BIGINT NOT NULL,
	created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timers_enabled_next_run_at
ON timers(enabled, next_run_at);

-- migrate:down
DROP INDEX IF EXISTS idx_timers_enabled_next_run_at;
DROP TABLE IF EXISTS timers;
