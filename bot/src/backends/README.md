# backends

Per-user virtual filesystem (no real disk access).

- `state_backend.ts` — namespace-scoped DB-backed store implementing `BackendProtocol` (deepagents); supports SQLite and PostgreSQL via injected `Bun.SQL`
- `types.ts` — `WorkspaceBackend` re-export
- `index.ts` — public exports

Namespace is set by `app.ts` to `caller.id` (e.g. `telegram:12345`) so users cannot read each other's files.
