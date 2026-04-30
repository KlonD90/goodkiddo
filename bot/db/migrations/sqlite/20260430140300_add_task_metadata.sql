-- migrate:up
ALTER TABLE tasks ADD COLUMN due_at INTEGER;
ALTER TABLE tasks ADD COLUMN next_check_at INTEGER;
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN loop_type TEXT;
ALTER TABLE tasks ADD COLUMN source_context TEXT;
ALTER TABLE tasks ADD COLUMN source_ref TEXT;
ALTER TABLE tasks ADD COLUMN last_nudged_at INTEGER;
ALTER TABLE tasks ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER;

-- migrate:down
ALTER TABLE tasks DROP COLUMN snoozed_until;
ALTER TABLE tasks DROP COLUMN nudge_count;
ALTER TABLE tasks DROP COLUMN last_nudged_at;
ALTER TABLE tasks DROP COLUMN source_ref;
ALTER TABLE tasks DROP COLUMN source_context;
ALTER TABLE tasks DROP COLUMN loop_type;
ALTER TABLE tasks DROP COLUMN priority;
ALTER TABLE tasks DROP COLUMN next_check_at;
ALTER TABLE tasks DROP COLUMN due_at;
