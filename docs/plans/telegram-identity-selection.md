# Plan: Telegram Identity Selection

## Overview

Add Telegram-facing identity presets. Authorized users can inspect and select a curated identity preset with `/identity` and reset to the default preset. Identity preferences are stored on the existing `harness_users` record, and changing identity creates a fresh system-prompt context so old and new identities do not silently share one active thread.

## DoD

**Identity presets:**

1. The app has a curated identity registry backed by raw markdown prompts.
2. The default preset resolves to the current `DO_IT` behavior.
3. Only presets explicitly included in the registry are visible to users.
4. Unknown or stale preset ids fall back to the default at runtime.

**User preference:**

1. `harness_users` can store a nullable selected identity id.
2. Existing users continue to work when the column is absent before startup.
3. `/identity use <preset>` persists the selected preset on the user.
4. `/identity reset` clears the selected preset and returns to default.
5. Restarting the bot keeps the selected preset for that user.

**Prompt boundary:**

1. New agent sessions use the user's selected identity.
2. Changing or resetting identity rebuilds the agent with the new prompt.
3. Changing or resetting identity creates a fresh active thread context before the next normal turn.
4. Identity command messages are not stored as user conversation turns.

## Validation Commands

- `bun tsc --noEmit`
- `bun test src/identities/registry.test.ts`
- `bun test src/permissions/store.test.ts`
- `bun test src/channels/session_commands.test.ts`
- `bun test src/channels/shared.test.ts`
- `bun test src/channels/telegram.test.ts`

---

### Task 1: Add the curated identity registry
- [ ] Create `src/identities/registry.ts`.
- [ ] Define an `IdentityPreset` type with `id`, `label`, `description`, and `prompt`.
- [ ] Register the current `DO_IT.md?raw` prompt as the default preset.
- [ ] Keep preset exposure explicit; do not scan all markdown files under `src/identities/`.
- [ ] Export helpers for listing presets, normalizing ids, resolving the default preset, and resolving a preset by id.
- [ ] Add `src/identities/registry.test.ts` covering default resolution, stable list order, id normalization, and unknown ids.
- [ ] Update `src/identities/README.md` to explain curated presets and how to add one.

### Task 2: Store identity preference on users
- [ ] Extend the `harness_users` table with a nullable identity column such as `identity_id`.
- [ ] Make startup/migration tolerant of existing SQLite and Postgres databases.
- [ ] Extend the user row and `UserRecord` type with the optional identity id.
- [ ] Add permission-store methods or upsert/update options for setting and clearing the selected identity.
- [ ] Ensure regular user upsert does not accidentally clear an existing identity preference.
- [ ] Add `src/permissions/store.test.ts` coverage for default null identity, setting, clearing, preserving across upsert, and stale arbitrary values.

### Task 3: Wire identity into app-agent creation
- [ ] Move the direct `DO_IT.md` dependency out of `src/app.ts` and behind the registry/resolver.
- [ ] Let `createAppAgent` receive the resolved identity prompt or selected identity id.
- [ ] Keep memory rules, active task snapshot, runtime context, and tool wiring unchanged.
- [ ] Extend `ChannelAgentSession` with selected identity state needed by `refreshAgent()`.
- [ ] Resolve the caller's stored identity when `createChannelAgentSession` creates the first agent bundle.
- [ ] Fall back to the default preset if the stored id is stale or unknown.
- [ ] Add tests in `src/channels/shared.test.ts` or a focused app-agent test proving default and selected prompts reach `buildSystemPrompt`.

### Task 4: Add identity session commands
- [ ] Extend `SessionCommandContext` with the current caller/user identity controls.
- [ ] Implement `/identity`, `/identity list`, `/identity current`, `/identity use <preset>`, and `/identity reset` in `src/channels/session_commands.ts`.
- [ ] Format replies without exposing raw prompt text.
- [ ] Return available slugs when a preset is unknown.
- [ ] Keep identity commands out of agent invocation and stored conversation history.
- [ ] Preserve the existing rule that Telegram slash commands wait until the current queued turn is finished.
- [ ] Add `src/channels/session_commands.test.ts` coverage for list/current/use/reset, unknown preset, unknown subcommand, and no-op selection of the already active preset.

### Task 5: Rotate prompt context on identity changes
- [ ] Decide the concrete boundary behavior: fresh thread with no summary, or fresh thread seeded by a neutral forced-checkpoint summary.
- [ ] Implement the chosen behavior for successful `/identity use <preset>` and `/identity reset`.
- [ ] Persist the new active thread id so the boundary survives bot restart.
- [ ] Rebuild the live agent after the selected identity and active thread id are updated.
- [ ] Reply with wording that makes the boundary visible to the user.
- [ ] Add regression tests proving old thread messages are not replayed under the new identity prompt.
- [ ] Add tests proving identity changes do not affect permissions, pending approvals, task ownership, attachments, timers, or outbound routing.

### Task 6: Update docs and final validation
- [ ] Update `src/channels/README.md` with `/identity` and prompt-boundary behavior.
- [ ] Update `src/permissions/README.md` if the user schema documentation needs the new identity field.
- [ ] Update `README.md` only if user-facing setup or operational workflow changes.
- [ ] Link this execution plan from `docs/features/feature-telegram-identity-selection.md` if that feature doc starts tracking execution links directly.
- [ ] Run all validation commands listed above.
- [ ] Mark tasks complete only after their implementation and tests pass.
