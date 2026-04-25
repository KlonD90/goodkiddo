# Plan: Telegram Free Tier Users

## Overview

Add a user tier field with `free` and `paid`, automatically create free Telegram users on first message, and make `admin add-user` create or upgrade users to paid. This plan does not add free-tier limitations; free users keep the same capabilities as paid users until a later feature introduces limits.

## DoD

**User model:**

1. `harness_users` stores a tier value.
2. Valid tiers are `free` and `paid`.
3. Tier remains separate from access status.
4. Existing manually provisioned users migrate intentionally, preferably to `paid`.

**Telegram provisioning:**

1. A Telegram chat without a user record is auto-created as `active` and `free`.
2. The first message from that chat continues through the normal bot flow.
3. Missing Telegram users are created as free users in this iteration.
4. Existing suspended Telegram users remain denied.
5. Free users have no feature restrictions in this iteration.

**Admin behavior:**

1. `add-user` creates a paid user when no user exists.
2. `add-user` upgrades an existing free user to paid.
3. `list-users` displays tier.
4. `suspend` and `activate` continue to manage ban/access status without changing tier.

## Validation Commands

- `bun tsc --noEmit`
- `bun test src/permissions/store.test.ts`
- `bun test src/channels/telegram.test.ts`
- `bun test src/channels/cli.test.ts`

---

### Task 1: Add user tier to permissions types and store
- [ ] Add a `UserTier` type/schema with `free` and `paid`.
- [ ] Extend `UserRecord` and the SQL row mapping with `tier`.
- [ ] Add a nullable or defaulted `tier` column to `harness_users`.
- [ ] Make table initialization/migration work for existing SQLite and Postgres databases.
- [ ] Choose and implement the migration rule for existing rows, preferably `paid` for existing admin-created users.
- [ ] Add tests covering default tier, explicit tier, row mapping, and tier independence from access status.

### Task 2: Support free creation and paid upgrade APIs
- [ ] Extend `upsertUser` or add a focused store method so callers can specify target tier.
- [ ] Ensure free auto-provisioning does not downgrade an existing paid user.
- [ ] Ensure `add-user` can upgrade an existing free user to paid.
- [ ] Ensure `suspend` and `activate` preserve tier.
- [ ] Add store tests for create-free, create-paid, upgrade free-to-paid, no paid-to-free downgrade during normal upsert, and status changes preserving tier.

### Task 3: Auto-provision Telegram free users
- [ ] Update Telegram caller resolution so a missing Telegram user is created as active/free.
- [ ] Remove first-contact handling that stops missing Telegram users before provisioning.
- [ ] Preserve denied behavior for existing suspended Telegram users.
- [ ] Use available Telegram metadata for display name when practical, but do not depend on it.
- [ ] Ensure the first message after auto-provisioning continues to session creation and normal turn handling.
- [ ] Add Telegram tests for first-message provisioning, first-message continuation, suspended-user denial, and no feature restriction for free users.

### Task 4: Update admin CLI behavior
- [ ] Make `bun src/bin/admin.ts add-user <entrypoint> <externalId> [displayName]` create or upgrade the user to paid.
- [ ] Update command output so it reports the resulting tier.
- [ ] Update `list-users` output to include tier.
- [ ] Keep `suspend` and `activate` output focused on status, not tier.
- [ ] Add or update admin/permissions tests if the admin CLI has test coverage; otherwise cover the underlying store behavior.

### Task 5: Update docs and final validation
- [ ] Update `src/permissions/README.md` to describe user tier versus user status.
- [ ] Update `src/channels/README.md` to describe Telegram free-tier auto-provisioning.
- [ ] Update `README.md` if the setup/access section describes admin pre-provisioning as required.
- [ ] Run all validation commands listed above.
- [ ] Mark tasks complete only after implementation and tests pass.
