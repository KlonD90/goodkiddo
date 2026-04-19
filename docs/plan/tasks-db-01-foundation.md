# Tasks: Interchangeable Databases — 01 Foundation

> Feature plan: [feature-interchangeable-databases.md](feature-interchangeable-databases.md)
> Next: [tasks-db-02-migrate-stores.md](tasks-db-02-migrate-stores.md)

## Task list

- [ ] **Create `src/db/index.ts`** — DB factory and dialect helper
  - **Files:** `src/db/index.ts` (new)
  - **Context:** This module is the only place `Bun.SQL` is constructed. Export two things:
    1. `createDb(url: string): SQL` — returns `new Bun.SQL(url)`. Type `SQL` is `InstanceType<typeof Bun.SQL>`.
    2. `detectDialect(url: string): 'sqlite' | 'postgres'` — returns `'sqlite'` if `url` starts with `sqlite:`, `'postgres'` for `postgres:` or `postgresql:` prefixes, throws for anything else.
    No other logic belongs here.
  - **Done when:** File compiles (`bun tsc --noEmit`), both exports are present and typed correctly.

- [ ] **Update config: replace `stateDbPath` with `databaseUrl`** — rename the config field and env var
  - **Files:** `src/config.ts`, `src/env.d.ts`
  - **Context:** `AppConfig` in `src/config.ts` has a `stateDbPath: string` field (default `"./state.db"`, env var `STATE_DB_PATH`). Replace it with `databaseUrl: string` (default `"sqlite://./state.db"`, env var `DATABASE_URL`). Update the `ConfigIssueField` union to remove `"STATE_DB_PATH"` and add `"DATABASE_URL"`. Update `src/env.d.ts` — add `DATABASE_URL` to `ProcessEnv`, remove `STATE_DB_PATH`. The wizard prompt for this field (if one exists) should ask for a database URL, not a file path.
  - **Done when:** `AppConfig.databaseUrl` exists, `AppConfig.stateDbPath` is gone, `bun tsc --noEmit` passes (type errors from call sites are expected at this stage and will be fixed in task list 03).
