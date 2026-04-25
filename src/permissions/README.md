# permissions

Multi-tenant tool permissions. Per-user rules in SQLite, default decision is `allow`, except `execute_*` tools which default to `ask`.

Users have two independent attributes: `tier` (free/paid) and `status` (active/suspended). Tier controls commercial account level; status controls access. A free user can be suspended, and a paid user can be suspended.

- `types.ts` — `Caller`, `ToolRule`, `ArgumentMatcher` (eq/in/glob/regex), `UserTier`, `UserStatus`
- `store.ts` — `harness_users` + `tool_permissions` tables; CRUD with tier and status support
- `engine.ts` — `resolveDecision(rules, tool, args)` — first match wins, default `allow` except `execute_*` uses `ask`
- `matcher.ts` — argument matcher evaluator (dotted paths, mini-glob)
- `approval.ts` — `ApprovalBroker` interface + CLI broker; outcomes `approve-once|always`, `deny-once|always`
- `commands.ts` — `/policy /allow /deny /ask /reset` for self-service rule management

Usage: instantiate `PermissionsStore`, hand it to the broker + tool guard, route slash-commands via `maybeHandleCommand` before invoking the agent.
