# backends

Per-user virtual filesystem (no real disk access).

- `sqlite_state_backend.ts` — namespace-scoped SQLite store implementing `BackendProtocol` (deepagents)
- `types.ts` — `WorkspaceBackend` re-export
- `index.ts` — public exports

Namespace is set by `app.ts` to `caller.id` (e.g. `telegram:12345`) so users cannot read each other's files. Postgres backend is planned.
