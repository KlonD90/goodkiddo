# Plan: Prepared Follow-ups — Nudge Preferences and Fatigue Guard v1

## Goal
Prevent proactive GoodKiddo from becoming spam. Add preference/fatigue controls so only meaningful follow-ups interrupt the user.

## Product doctrine reminder
GoodKiddo is a Telegram-native safe-by-construction assistant for non-technical solo entrepreneurs. Harmless safe-space actions may happen directly. Outside-world final effects are not capabilities: no sending, publishing, paying, submitting irreversible forms, deleting/canceling external state, inviting others, or deciding on behalf of the user.

Prepared Follow-ups quality bar: before interrupting, GoodKiddo must do useful work: recall context, check available evidence, prepare a draft/checklist/recommendation, or ask one specific missing detail.

## Dependency / queueing
- Can be designed independently.
- Full enforcement plugs into digest/proactive scheduler later.
- Groomed now; add `gode` when scheduler integration point is known.

## Existing areas to inspect
- user profile/memory files: `bot/src/memory/user_profile.ts`, runtime context
- scheduled timers: `bot/src/capabilities/timers/`
- channel outbound/delivery code
- config/preferences patterns if any

## Scope
In:
- User-level proactive preferences: timezone, quiet hours, digest time, max nudges/day, pushiness level.
- “Less like this” feedback signal storage.
- A small decision helper: send now / batch / suppress based on fatigue rules.

Out:
- Permission prompts.
- Complex notification settings UI.
- Multi-user/team policies.

## Validation Commands
- `bun test bot/src/memory/user_profile.test.ts bot/src/capabilities/timers/scheduler.test.ts bot/src/channels/outbound.test.ts`
- `bun run typecheck`
- `bun run check`

### Task 1: Preference data model
- [ ] Decide where proactive preferences live.
- [ ] Add defaults that are conservative and Telegram-friendly.
- [ ] Preserve existing profiles/memory behavior.

### Task 2: Fatigue decision helper
- [ ] Implement send/batch/suppress decision from preferences and recent nudge count.
- [ ] Respect quiet hours.
- [ ] Exempt explicit user-requested timers/reminders if appropriate.

### Task 3: Feedback handling
- [ ] Store “less like this” as a preference signal.
- [ ] Ensure it affects future proactive sends without deleting user data.

### Task 4: Tests
- [ ] Test quiet hours suppression/batching.
- [ ] Test max nudges/day.
- [ ] Test explicit digest time.
- [ ] Test less-like-this signal.

### Task 5: Docs
- [ ] Document anti-spam behavior and defaults.

## Acceptance Criteria
- There is a tested fatigue guard function/module.
- GoodKiddo has clear defaults that reduce noise.
- No permission/approval UX is introduced.
