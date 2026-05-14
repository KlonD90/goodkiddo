# backends

Per-user virtual filesystem (no real disk access).

- `state_backend.ts` — namespace-scoped PostgreSQL-backed store implementing `BackendProtocol` (deepagents) via injected Prisma client
- `types.ts` — `WorkspaceBackend` re-export
- `index.ts` — public exports

Namespace is set by `app.ts` to `caller.id` (e.g. `telegram:12345`) so users cannot read each other's files.
