# Tasks: Interchangeable Databases — 03 Checkpoint Saver & Wiring

> Feature plan: [feature-interchangeable-databases.md](feature-interchangeable-databases.md)
> Previous: [tasks-db-02-migrate-stores.md](tasks-db-02-migrate-stores.md)

Assumes task lists 01 and 02 are complete.

## Task list

- [ ] **Create `sql_saver.ts` shell with DDL setup** — class scaffold and table creation
  - **Files:** `src/checkpoints/sql_saver.ts` (new)
  - **Context:** Read `src/checkpoints/bun_sqlite_saver.ts` before starting — the new class mirrors its structure exactly, only replacing `bun:sqlite` with `Bun.sql`. Create `SqlSaver extends MemorySaver`. Constructor signature: `constructor(db: SQL, dialect: 'sqlite' | 'postgres')`. In the constructor, run `CREATE TABLE IF NOT EXISTS` for both `langgraph_checkpoints` and `langgraph_checkpoint_writes`. The only DDL difference is binary columns: SQLite uses `BLOB NOT NULL`, PostgreSQL uses `BYTEA NOT NULL`. Use `dialect` to pick the right DDL string. For SQLite, also run `PRAGMA journal_mode = WAL`. Copy the `WRITE_INDEX_BY_CHANNEL` map, `toBytes`, `metadataMatchesFilter`, `serialize`, `deserialize`, and `buildCheckpointTuple` helpers verbatim from `bun_sqlite_saver.ts` — they do not touch the DB directly. Stub out `getTuple`, `list`, `put`, `putWrites`, `deleteThread` with `throw new Error("not implemented")`.
  - **Done when:** File compiles, DDL runs without error when instantiated in a quick smoke test with a SQLite URL.

- [ ] **Implement `getTuple` and `readPendingWrites`**
  - **Files:** `src/checkpoints/sql_saver.ts`
  - **Context:** Port `getTuple` and the private `readPendingWrites` helper from `bun_sqlite_saver.ts`. Replace `this.db.query<T, P>(sql).get(...)` / `.all(...)` with `Bun.sql` tagged templates. `readPendingWrites` returns an array of rows — use `` await this.db`SELECT ... WHERE ...` `` and type the result. `getTuple` calls `readPendingWrites` and `buildCheckpointTuple` — those are already ported in the previous task. The only tricky part: `Bun.sql` returns plain objects, so binary columns come back as `Buffer` or `Uint8Array` depending on dialect — `toBytes()` already handles both, so pass column values through it.
  - **Done when:** `getTuple` stubs are replaced with real implementations; `throw new Error("not implemented")` is gone from both.

- [ ] **Implement `list`, `put`, `putWrites`, and `deleteThread`**
  - **Files:** `src/checkpoints/sql_saver.ts`
  - **Context:** Port the remaining four methods from `bun_sqlite_saver.ts`. `list` is an `async generator` — use `for...of` over the `Bun.sql` result array (generators can't `yield` inside a callback, so fetch all rows first then iterate). `put` uses an `ON CONFLICT ... DO UPDATE` upsert — same syntax in both SQLite and PostgreSQL. `putWrites` loops over writes and upserts each; the `WRITE_INDEX_BY_CHANNEL` negative-index logic stays unchanged. `deleteThread` issues two `DELETE` statements. Replace all `this.db.prepare(...).run(...)` calls with tagged templates.
  - **Done when:** All five methods implemented, no `throw new Error("not implemented")` remaining.

- [ ] **Wire in `SqlSaver`, delete `bun_sqlite_saver.ts`**
  - **Files:** `src/checkpoints/sql_saver.ts`, `src/checkpoints/bun_sqlite_saver.ts` (delete), `src/channels/shared.ts`
  - **Context:** Add `export function createPersistentCheckpointer(db: SQL, dialect: 'sqlite' | 'postgres'): BaseCheckpointSaver` to `sql_saver.ts` — it returns `new SqlSaver(db, dialect)`. In `src/channels/shared.ts`, update the import from `bun_sqlite_saver` to `sql_saver` and update the call signature (currently `createPersistentCheckpointer(config.stateDbPath)`). Delete `src/checkpoints/bun_sqlite_saver.ts`. Verify no other files import from `bun_sqlite_saver`.
  - **Done when:** `bun_sqlite_saver.ts` is deleted, `bun tsc --noEmit` passes.

- [ ] **Update all instantiation sites to use the shared `SQL` instance**
  - **Files:** `src/channels/shared.ts`, `src/channels/cli.ts`, `src/channels/telegram.ts`, `src/server/http.ts`, `src/app.ts`, `src/server/routes.ts`, `src/bin/admin.ts`
  - **Context:** Each of these files currently constructs a store with `{ dbPath: config.stateDbPath }` or `{ dbPath: DB_PATH }`. The pattern is the same in all of them: import `createDb` and `detectDialect` from `src/db/index.ts`, call `const db = createDb(config.databaseUrl); const dialect = detectDialect(config.databaseUrl)` once at the top of the startup block, then pass `{ db, dialect }` to every store constructor. For `src/server/routes.ts`: the function `openWorkspace(stateDbPath, userId)` receives `stateDbPath: string` as a parameter — change the signature to `openWorkspace(db: SQL, dialect, userId)` and update the call sites inside `routes.ts`. For `src/bin/admin.ts`: it reads `DB_PATH` from an env var directly — replace with `DATABASE_URL` and use `createDb` / `detectDialect`. After all changes, `bun tsc --noEmit` must pass with zero errors.
  - **Done when:** No file imports from `bun:sqlite`, `bun tsc --noEmit` is clean, `./dev.sh` starts without database errors.
