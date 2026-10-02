# Persistence

This folder owns database schema, migrations, and storage access for GoodKiddo state.

## Main Files

- `assistant-store.ts` — active assistant SQLite entrypoint; existing schemas plus additive `assistant-page-schema.ts`.
- `assistant-pages.ts`, `assistant-page-expiry.ts` — static mini-page snapshots, same-chat metadata, owner revocation and bounded expiry; snapshot bytes count in shared file quotas.
- `db.ts` - current SQLite schema setup and persistence helpers
- `restart-context.ts` - restart-related recovery and resume context

## Boundaries

- Keep SQL, schema migrations, and storage normalization in this folder.
- Return domain-shaped data and keep SQL-specific quirks local.
- Do not mix routing, platform formatting, or channel-specific behavior into persistence helpers.
- When a persistence file starts combining unrelated domains, split by capability instead of growing a single storage module.

## Maintainability Notes

- Schema and migrations should be easy to find and reason about.
- Query helpers should be grouped by domain such as messages, sessions, tasks, room modes, or paired workflows.
- Large persistence changes should follow the review triggers in [`MAINTAINABILITY.md`](../../MAINTAINABILITY.md).
