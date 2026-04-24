# permissions

Multi-tenant tool permissions. Per-user rules in SQLite, default decision is `allow`, except `execute_*` tools which default to `ask`.

- `types.ts` — `Caller`, `ToolRule`, `ArgumentMatcher` (eq/in/glob/regex)
- `store.ts` — `harness_users` + `tool_permissions` tables; CRUD
- `engine.ts` — `resolveDecision(rules, tool, args)` — first match wins, default `allow` except `execute_*` uses `ask`
- `matcher.ts` — argument matcher evaluator (dotted paths, mini-glob)
- `approval.ts` — `ApprovalBroker` interface + CLI broker; outcomes `approve-once|always`, `deny-once|always`
- `commands.ts` — `/policy /allow /deny /ask /reset` for self-service rule management

Usage: instantiate `PermissionsStore`, hand it to the broker + tool guard, route slash-commands via `maybeHandleCommand` before invoking the agent.
