## Summary

Introduce a proper versioned database migration foundation for the bot using dbmate, so schema changes are explicit/reviewable and Prepared Follow-ups does not add more store-local custom migration helpers.

This blocks/reworks PR #21 / issue #10, where task metadata was added via custom inline `ALTER TABLE` logic in `TaskStore`.

## Product/engineering context

GoodKiddo currently uses `Bun.SQL` for runtime database access and supports SQLite + PostgreSQL dialects. Keep that runtime model. This task is only about schema evolution.

Do not adopt a full ORM unless absolutely necessary. Prefer lightweight SQL migrations.

## Desired approach

- Add dbmate as the migration tool or an equivalent minimal SQL migration tool if dbmate has a hard blocker.
- Add versioned SQL migrations with a migration tracking table.
- Support both SQLite and PostgreSQL.
- Use dialect-specific migration directories because DDL differs between SQLite and PostgreSQL.
- Add a small wrapper/script if needed to normalize GoodKiddo/Bun SQLite URLs for dbmate.
- Run migrations before constructing stores / before production-like bot startup.
- Keep runtime queries on `Bun.SQL`.
- Do not add new store-local custom migration helpers like `migrateTaskMetadataColumns()`.

Suggested layout, adjust if repo conventions suggest better names:

```text
bot/db/migrations/sqlite/
bot/db/migrations/postgres/
bot/src/db/migrate.ts
```

## Scope

### Task 1: Verify tooling fit

- [x] Confirm dbmate can be used from Bun scripts for SQLite + PostgreSQL (`dbmate` npm CLI added as a bot dev dependency).
- [x] Verify SQLite URL normalization need and implement a safe wrapper if needed (`sqlite://./...` normalizes to dbmate-compatible `sqlite:./...`).
- [x] Document any chosen alternative if dbmate cannot fit (not needed; dbmate fits).

### Task 2: Add migration command surface

- [x] Add package scripts for migration operations, e.g.:
  - `db:migrate`
  - `db:status`
  - `db:rollback`
  - `db:new` if practical
- [x] Ensure scripts can choose dialect based on `DATABASE_URL` / app config.
- [x] Keep commands usable from repo root/Bun workspace conventions.

### Task 3: Add baseline migrations

- [x] Add initial/baseline migration files for existing bot tables that are relevant to stores already managing schema.
- [x] At minimum cover the `tasks` table so PR #21 can be reworked on top of the migration foundation.
- [x] If practical, include existing timer metadata migration debt in a separate migration, but do not expand scope too far.

### Task 4: Add task metadata migration

- [x] Add a proper versioned migration for the Prepared Follow-ups task metadata columns from #10:
  - `due_at`
  - `next_check_at`
  - `priority`
  - `loop_type`
  - `source_context`
  - `source_ref`
  - `last_nudged_at`
  - `nudge_count`
  - `snoozed_until`
- [x] Use dialect-appropriate SQL.
- [x] Keep old rows valid with defaults/nullability.

### Task 5: Rework store startup contract

- [x] Remove any new `TaskStore` custom migration helper from PR #21.
- [x] Store constructors may keep defensive `CREATE TABLE IF NOT EXISTS` temporarily if existing repo pattern needs it, but new schema evolution should come from migrations.
- [x] Prefer docs/tests that make migrations the supported production path.

### Task 6: Tests

Follow TDD for new migration wrapper behavior.

Add tests for:
- [x] Migration URL/dialect selection.
- [x] SQLite URL normalization if implemented.
- [x] Generated command/env behavior without shelling into real external services where avoidable.
- [x] Task store compatibility with migrated schema.

Existing #10 tests for task metadata should keep passing after rework.

### Task 7: Docs

Update relevant docs/README with:
- [ ] How to run migrations locally.
- [ ] How deployment/startup should run migrations before bot boot.
- [ ] Why schema changes belong in migrations, not store-local helpers.

## Validation Commands

Use Bun, not npm/pnpm.

Suggested commands:

```bash
bun install --frozen-lockfile
bun run --filter goodkiddo-bot test src/db/ src/tasks/store.test.ts src/tasks/reconcile.test.ts src/tools/task_tools.test.ts
bun run --filter goodkiddo-bot typecheck
bun run --filter goodkiddo-bot check
```

If Docker is needed for parity:

```bash
docker run --rm -v "$PWD":/app -w /app/bot oven/bun:1-debian sh -c "bun install --frozen-lockfile && bun test src/db/ src/tasks/store.test.ts src/tasks/reconcile.test.ts src/tools/task_tools.test.ts && bun run typecheck"
```

## Acceptance Criteria

- PR #21 can be reworked without custom inline `TaskStore` migration logic.
- Migration files are versioned and reviewable.
- SQLite + PostgreSQL dialect differences are explicit.
- Migration commands are documented.
- Tests cover migration wrapper behavior and task metadata compatibility.
- No local machine paths or ralphex log paths appear in public PR body.
