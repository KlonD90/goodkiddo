-- migrate:up
CREATE TABLE IF NOT EXISTS tasks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	thread_id_created TEXT NOT NULL,
	thread_id_completed TEXT,
	list_name TEXT NOT NULL,
	title TEXT NOT NULL,
	note TEXT,
	status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'dismissed')),
	status_reason TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	completed_at INTEGER,
	dismissed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_status_updated_at
ON tasks(user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_user_list_status
ON tasks(user_id, list_name, status);

-- migrate:down
DROP INDEX IF EXISTS idx_tasks_user_list_status;
DROP INDEX IF EXISTS idx_tasks_user_status_updated_at;
DROP TABLE IF EXISTS tasks;
