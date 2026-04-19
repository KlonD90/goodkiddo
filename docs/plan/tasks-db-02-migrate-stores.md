# Tasks: Interchangeable Databases — 02 Migrate Stores

> Feature plan: [feature-interchangeable-databases.md](feature-interchangeable-databases.md)
> Previous: [tasks-db-01-foundation.md](tasks-db-01-foundation.md)
> Next: [tasks-db-03-checkpoint-and-wiring.md](tasks-db-03-checkpoint-and-wiring.md)

Assumes task list 01 is complete (`src/db/index.ts` exists, `AppConfig.databaseUrl` exists).

## Task list

- [x] **Rewrite `SqliteStateBackend` to use injected `Bun.SQL`** — remove `bun:sqlite`, make methods async
  - **Files:** `src/backends/sqlite_state_backend.ts`
  - **Context:** Replace `import { Database } from "bun:sqlite"` with no DB import. Change `SqliteStateBackendOptions` to accept `db: SQL; dialect: 'sqlite' | 'postgres'` instead of `dbPath?: string`. In the constructor, remove the `mkdirSync` and `new Database(...)` calls; assign the injected `db`. Run `CREATE TABLE IF NOT EXISTS agent_files ...` in the constructor — same DDL for both dialects (no BLOB columns here, content is TEXT). For SQLite dialect only, also run `` await db`PRAGMA journal_mode = WAL` ``. Convert all `this.database.query(...).get/all/run(...)` calls to `Bun.sql` tagged templates. All public methods (`read`, `write`, `edit`, `grepRaw`, `globInfo`, `lsInfo`, `uploadFiles`, `downloadFiles`) return `Promise<T>` — `BackendProtocol` uses `MaybePromise<T>` so this is safe. Keep `normalizePath` exported — it is imported by `access_store.ts` and `server/routes.ts`.
  - **Done when:** File compiles, `import { Database } from "bun:sqlite"` is gone, all methods are async.

- [x] **Rewrite `PermissionsStore` to use injected `Bun.SQL`** — handle two DDL differences
  - **Files:** `src/permissions/store.ts`
  - **Context:** Replace `import { Database } from "bun:sqlite"` with no DB import. Change `PermissionsStoreOptions` to `{ db: SQL; dialect: 'sqlite' | 'postgres' }`. Remove `mkdirSync`. DDL differences to handle:
    - `tool_permissions.id`: SQLite → `INTEGER PRIMARY KEY AUTOINCREMENT`, PostgreSQL → `SERIAL PRIMARY KEY`
    - One query uses `IFNULL(args_matcher, '')` — change to `COALESCE(args_matcher, '')` (works in both)
    - SQLite dialect: run `PRAGMA journal_mode = WAL` after table creation
    All methods become async. The `result.changes` pattern from `bun:sqlite` is not available in `Bun.sql`; use `SELECT changes()` (SQLite) or `RETURNING` / row counts from `Bun.sql` result. Alternatively, for the two methods that return a count (`deleteMatchingRules`, `deleteAllRulesForUser`), return the length of the `Bun.sql` result array.
  - **Done when:** File compiles, `import { Database } from "bun:sqlite"` is gone, all methods async.

- [ ] **Rewrite `AccessStore` to use injected `Bun.SQL`** — straightforward, no BLOB or AUTOINCREMENT
  - **Files:** `src/server/access_store.ts`
  - **Context:** Replace `import { Database } from "bun:sqlite"` with no DB import. Change `AccessStoreOptions` to `{ db: SQL; dialect: 'sqlite' | 'postgres'; now?: () => number }`. Remove `mkdirSync`. DDL is all TEXT/INTEGER — same for both dialects; add `PRAGMA journal_mode = WAL` conditionally for SQLite. Convert all queries to `Bun.sql` tagged templates. `sweepExpired` and `revokeByUser` return counts — derive from result array length. `normalizePath` import from `../backends/sqlite_state_backend` stays valid for now (file not yet renamed).
  - **Done when:** File compiles, `import { Database } from "bun:sqlite"` is gone, all methods async.

- [ ] **Rename backend file and fix all affected imports**
  - **Files:** `src/backends/sqlite_state_backend.ts` → `src/backends/state_backend.ts`, `src/backends/index.ts`, `src/server/access_store.ts`, `src/server/routes.ts`
  - **Context:** Rename `sqlite_state_backend.ts` to `state_backend.ts`. The class and factory function names can keep their names for now — renaming them is a separate concern. Update `src/backends/index.ts` to re-export from `./state_backend` instead of `./sqlite_state_backend`. Fix the `normalizePath` import in `src/server/access_store.ts` (currently `../backends/sqlite_state_backend`) and `src/server/routes.ts` (currently `../backends`). Update any other files that import directly from `sqlite_state_backend` by path.
  - **Done when:** `sqlite_state_backend.ts` no longer exists, `bun tsc --noEmit` produces no errors related to this rename. Type errors from instantiation sites (still passing `dbPath`) are expected and fixed in task list 03.
