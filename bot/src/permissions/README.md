# permissions

This module now stores user access state only.

Users have two independent attributes: `tier` (free/paid) and `status`
(active/suspended). Tier controls commercial account level; status controls
whether a user can access the bot. A free user can be suspended, and a paid user
can be suspended.

- `types.ts` — `Caller`, `UserTier`, `UserStatus`, and user identity types
- `store.ts` — `harness_users` CRUD with tier, status, and identity support

PostgreSQL user records store `created_at` as `BIGINT` because the value is an
epoch-millisecond timestamp from `Date.now()`. `PermissionsStore` startup
migrates older Postgres `harness_users.created_at` columns from `INTEGER` to
`BIGINT`.

Tool-level permission rules and approval prompts have been removed. Enabled
tools execute directly; coarse access is handled by user status and feature
configuration such as `ENABLE_EXECUTE`.
