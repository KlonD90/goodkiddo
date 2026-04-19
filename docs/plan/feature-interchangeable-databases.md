# Feature: Interchangeable Databases

## Summary
Replace all direct `bun:sqlite` usage with `Bun.sql` — the unified Bun 1.3 SQL API that supports both SQLite and PostgreSQL through the same tagged-template interface. A single `DATABASE_URL` env var selects the backend: `sqlite://./state.db` for dev, `postgresql://...` for production. All four stores (virtual FS, permissions, access grants, checkpoint saver) share one `Bun.SQL` instance created at startup. No duplication, no adapter shims, no extra dependencies.

## User cases
- An operator sets `DATABASE_URL=postgresql://user:pass@db-host/app` and the service starts on PostgreSQL without any code change.
- A developer runs locally with `DATABASE_URL=sqlite://./state.db` and gets identical behaviour to production.
- A new store added to the codebase receives the shared `SQL` instance via its constructor — it never opens a database connection on its own.

## Scope
**In:**
- Replace all `import { Database } from "bun:sqlite"` with `Bun.SQL` instance injection
- Single `DATABASE_URL` config key replaces `stateDbPath` and all per-store `dbPath` options
- Shared `Bun.SQL` instance created once at app startup, passed to every store
- DDL dialect differences handled per store (see design notes)
- Checkpoint saver rewritten as `SqlSaver` in `src/checkpoints/sql_saver.ts`; old `bun_sqlite_saver.ts` deleted
- All store methods become async (returning `Promise<T>`), which `BackendProtocol`'s `MaybePromise<T>` already allows

**Out:**
- Migration tooling — tables are still auto-created on startup with `CREATE TABLE IF NOT EXISTS`
- Connection pool tuning
- Read-replica or multi-tenant schema isolation

## Design notes

**`Bun.SQL` API:**
```ts
const db = new Bun.SQL(process.env.DATABASE_URL);        // SQLite or PostgreSQL
const rows = await db`SELECT * FROM t WHERE id = ${id}`; // tagged template, returns Row[]
await db`INSERT INTO t (a, b) VALUES (${a}, ${b})`;      // no return value needed
```

**Dialect detection** — `src/db/index.ts` exports:
```ts
export function detectDialect(url: string): 'sqlite' | 'postgres'
```
Parses the URL prefix: `sqlite:` → `'sqlite'`, `postgres:` / `postgresql:` → `'postgres'`.

**DDL differences per store:**

| Store | SQLite | PostgreSQL |
|---|---|---|
| All stores | `PRAGMA journal_mode = WAL` on init | skip PRAGMA |
| `permissions/store.ts` | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` |
| `permissions/store.ts` | `IFNULL(x, '')` | `COALESCE(x, '')` |
| `checkpoints/sql_saver.ts` | `BLOB NOT NULL` | `BYTEA NOT NULL` |

All other stores use only `TEXT` and `INTEGER` columns — same DDL for both dialects.

**Binary data in `sql_saver.ts`:** pass `Buffer` / `Uint8Array` directly as tagged-template values; `Bun.sql` encodes them as `BLOB` (SQLite) or `BYTEA` (PostgreSQL) transparently once the column type is declared correctly.

**`normalizePath` move:** `src/server/access_store.ts` and `src/server/routes.ts` currently import `normalizePath` from `src/backends/sqlite_state_backend.ts`. When that file is renamed to `state_backend.ts` the import path must be updated in both files.

**Instantiation sites** that need to be updated to use a shared `SQL` instance:
- `src/bin/admin.ts` — `new PermissionsStore({ dbPath })`
- `src/channels/cli.ts` — `new PermissionsStore({ dbPath })`
- `src/channels/telegram.ts` — `new PermissionsStore({ dbPath })`
- `src/channels/shared.ts` — `createPersistentCheckpointer(dbPath)`
- `src/server/http.ts` — `new AccessStore({ dbPath })`
- `src/app.ts` — `new SqliteStateBackend({ dbPath, namespace })`
- `src/server/routes.ts` — `new SqliteStateBackend({ dbPath, namespace })` (receives `stateDbPath` as a plain string today; must switch to receiving `{ db, dialect }`)
