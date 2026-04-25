# Feature: Telegram Free Tier Users

## Summary

Allow any new Telegram chat that messages the bot to become an active free-tier user automatically. The free tier should exist as the default account tier, but it should not restrict capabilities in this iteration. Admin provisioning should still exist, but `admin add-user` should effectively create or upgrade a user to paid.

## User Cases

- A new Telegram user can message the bot and receive access as a free-tier user without an admin pre-creating their account.
- An admin can run `add-user telegram <chatId>` to upgrade that Telegram user to paid.
- An admin can suspend a bad user so that the bot denies that known user even though unknown Telegram users are otherwise auto-created as free.
- Future work can add limitations for free-tier users without changing the basic user identity model again.

## Scope

**In:**

- Add an account tier concept to users, starting with `free` and `paid`.
- Default all automatically created Telegram users to `free`.
- Keep free-tier users fully functional for now.
- Make `admin add-user` create or upgrade users to `paid`.
- Keep `suspended` as the ban status for known bad users.
- Show tier in admin user listing.

**Out:**

- Free-tier usage limits, quotas, rate limits, tool restrictions, model restrictions, or billing.
- Payment integration.
- Self-service upgrade flows inside Telegram.
- Tier-specific prompt behavior.
- Automatic free-tier provisioning for non-Telegram entrypoints unless explicitly needed later.
- A replacement denial or abuse-control flow. With free-tier auto-provisioning, missing Telegram users are created as free users in this iteration.

## Design Notes

### User State Model

Tier and access status should stay separate:

- `status`: whether a known user is allowed to use the bot (`active` or `suspended`)
- `tier`: what account tier the user has (`free` or `paid`)

This avoids overloading access control with commercial meaning. A paid user can still be suspended, and a free user can still be active. Suspension is the ban mechanism for known bad users; tier is the commercial/account level.

The existing `harness_users` table is the right home for the tier field because tier is a one-to-one property of the user account.

### Telegram Auto-Provisioning

When a Telegram message arrives from a chat without a `harness_users` record, the bot should create an active user with:

- `entrypoint = telegram`
- `external_id = <chat id>`
- `display_name` from available Telegram chat/user metadata when safe
- `tier = free`
- `status = active`

After creation, the message should continue through the normal session flow as a free user. Everyone missing from the Telegram user table becomes free. Existing suspended users must remain denied and must not be recreated or reactivated by messaging the bot again.

### Admin Upgrade Behavior

`bun src/bin/admin.ts add-user telegram <chatId> [displayName]` should create or upgrade the target user to `paid`.

This keeps the operational workflow simple:

- user messages the bot first and becomes free
- admin runs `add-user` when they want that user to be paid
- admin runs `suspend` when they need to ban a known bad user

The command name can stay `add-user` for now even though its meaning expands to "create or upgrade to paid." The command output should make the resulting tier visible to avoid confusion.

### Compatibility

Existing databases should migrate safely:

- users without a tier should behave as `paid` or `free` only by an intentional migration decision
- for the requested behavior, new automatically provisioned Telegram users are `free`
- existing manually added users should most likely become `paid` during migration because admin-created access previously represented explicit approval

The execution plan should make this migration rule explicit before implementation.

### Runtime Behavior

Free-tier users should currently pass through the same permission, model, tool, attachment, memory, and session paths as paid users. The tier is stored and surfaced for future enforcement, but no behavior should be limited yet.

This feature changes access onboarding: Telegram no longer requires admin pre-provisioning for every new chat. Known bad users can still be banned with `suspended`. Any future quota or abuse-control behavior beyond manual suspension should be planned separately.

## Validation Expectations

Implementation tasks belong in `docs/plans/`, but this feature should eventually be validated against these observable outcomes:

- A new Telegram chat creates an active free-tier user on first message.
- The first message from a new Telegram chat continues to the normal bot flow after provisioning.
- An existing suspended Telegram user remains denied.
- `admin add-user telegram <chatId>` creates a paid user when none exists.
- `admin add-user telegram <chatId>` upgrades an existing free user to paid.
- Admin suspend/activate behavior remains independent from tier.
- `admin list-users` shows each user's tier.
- Free-tier users have no functional restrictions in this iteration.

## Risks and Open Questions

- **Spam and abuse:** Open Telegram auto-provisioning broadens access. Manual suspension remains available for known bad users, but this feature deliberately adds no automatic limits or abuse detection yet.
- **Existing-user migration:** Existing manually added users likely map to `paid`, but the implementation should choose this explicitly.
- **Display names:** Telegram metadata may be incomplete or user-controlled. Treat it as display-only and never as authority.
- **Future limits:** The tier field should be simple enough for future quota or capability checks, but those checks are out of scope here.
