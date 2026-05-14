-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE IF NOT EXISTS "harness_users" (
    "id" TEXT NOT NULL,
    "entrypoint" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_name" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'paid',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" BIGINT NOT NULL,
    "identity_id" TEXT,

    CONSTRAINT "harness_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "tasks" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "thread_id_created" TEXT NOT NULL,
    "thread_id_completed" TEXT,
    "list_name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL,
    "status_reason" TEXT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,
    "completed_at" BIGINT,
    "dismissed_at" BIGINT,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "timers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "md_file_path" TEXT NOT NULL,
    "cron_expression" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'always',
    "message" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" INTEGER NOT NULL DEFAULT 1,
    "last_run_at" BIGINT,
    "last_error" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" BIGINT NOT NULL,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "timers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_files" (
    "namespace" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "modified_at" TEXT NOT NULL,

    CONSTRAINT "agent_files_pkey" PRIMARY KEY ("namespace","path")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "active_threads" (
    "caller" TEXT NOT NULL,
    "active_thread_id" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "active_threads_pkey" PRIMARY KEY ("caller")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "forced_checkpoints" (
    "id" TEXT NOT NULL,
    "caller" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "source_boundary" TEXT NOT NULL,
    "summary_payload" TEXT NOT NULL,

    CONSTRAINT "forced_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "fs_access_grants" (
    "link_uuid" TEXT NOT NULL,
    "bearer_token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope_path" TEXT NOT NULL,
    "scope_kind" TEXT NOT NULL,
    "expires_at" BIGINT NOT NULL,
    "created_at" BIGINT NOT NULL,
    "revoked_at" BIGINT,

    CONSTRAINT "fs_access_grants_pkey" PRIMARY KEY ("link_uuid")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "langgraph_checkpoints" (
    "thread_id" TEXT NOT NULL,
    "checkpoint_ns" TEXT NOT NULL,
    "checkpoint_id" TEXT NOT NULL,
    "checkpoint_type" TEXT NOT NULL,
    "checkpoint_data" BYTEA NOT NULL,
    "metadata_type" TEXT NOT NULL,
    "metadata_data" BYTEA NOT NULL,
    "parent_checkpoint_id" TEXT,

    CONSTRAINT "langgraph_checkpoints_pkey" PRIMARY KEY ("thread_id","checkpoint_ns","checkpoint_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "langgraph_checkpoint_writes" (
    "thread_id" TEXT NOT NULL,
    "checkpoint_ns" TEXT NOT NULL,
    "checkpoint_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "write_idx" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "value_type" TEXT NOT NULL,
    "value_data" BYTEA NOT NULL,

    CONSTRAINT "langgraph_checkpoint_writes_pkey" PRIMARY KEY ("thread_id","checkpoint_ns","checkpoint_id","task_id","write_idx")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "harness_users_entrypoint_external_id_key" ON "harness_users"("entrypoint", "external_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_tasks_user_status_updated_at" ON "tasks"("user_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_tasks_user_list_status" ON "tasks"("user_id", "list_name", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_timers_enabled_next_run_at" ON "timers"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_agent_files_namespace_path" ON "agent_files"("namespace", "path");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_forced_checkpoints_caller_thread" ON "forced_checkpoints"("caller", "thread_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "fs_access_grants_bearer_token_key" ON "fs_access_grants"("bearer_token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_fs_access_grants_user" ON "fs_access_grants"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_langgraph_checkpoints_lookup" ON "langgraph_checkpoints"("thread_id", "checkpoint_ns", "checkpoint_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_langgraph_checkpoint_writes_lookup" ON "langgraph_checkpoint_writes"("thread_id", "checkpoint_ns", "checkpoint_id");
