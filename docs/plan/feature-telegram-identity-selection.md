# Feature: Telegram Identity Selection

## Summary

Add Telegram commands that let authorized bot users choose from curated agent identity presets. An identity preset is a named system-prompt profile, such as the current default `DO_IT` behavior or future focused variants. The selected identity should persist per caller, apply to future turns after the command is accepted, and remain an explicit control-plane setting rather than ordinary model-visible chat text.

## User Cases

- A Telegram user can run `/identity` to see their current identity and the available presets.
- A Telegram user can run `/identity use <preset>` to switch the bot into a known behavior profile without editing environment variables or redeploying.
- A Telegram user can run `/identity current` to confirm which preset is active before starting work.
- A Telegram user can run `/identity reset` to return to the server default identity.
- An operator can add or remove presets by editing a curated identity registry, without exposing every markdown file in `src/identities/` automatically.

## Scope

**In:**

- Telegram-visible `/identity` command with subcommands:
  - `/identity`
  - `/identity list`
  - `/identity current`
  - `/identity use <preset>`
  - `/identity reset`
- Curated identity preset registry backed by markdown prompts in `src/identities/`.
- Per-user persisted identity preference on the existing authorized user record.
- A clear system-prompt boundary when the identity changes, so old and new presets do not silently blend inside one live turn.
- Documentation updates for identities and Telegram commands.

**Out:**

- Letting Telegram users create or edit arbitrary identity prompts.
- Per-message identity overrides.
- Role-based identity visibility rules beyond existing authorized-user checks.
- Automatically exposing every prompt file under `src/identities/`.
- Migrating old conversation history or checkpoints when identity changes.

## Proposed Command Behavior

`/identity`

Shows the current identity and a compact list of available presets. This should be the friendly default because Telegram command menus cannot express nested arguments.

`/identity list`

Lists preset slugs, display names, and one-line descriptions. The reply should avoid dumping full prompt content.

`/identity current`

Shows the active preset and whether it came from the caller's saved preference or the server default.

`/identity use <preset>`

Validates `<preset>` against the curated registry, persists the caller preference, updates the live channel session, refreshes the agent, and replies with a confirmation. The command should be accepted only when no current turn is running, following the existing Telegram command queue rule.

Changing identity is a prompt boundary. The confirmation should say that future replies will use the new preset and that the conversation was moved to a fresh system-prompt context.

`/identity reset`

Deletes the caller preference, falls back to the server default, refreshes the agent, and replies with the active default.

Resetting is the same kind of prompt boundary as selecting a non-default preset.

Unknown presets should return a concise error plus the available slugs. Unknown subcommands should return the supported forms.

## Design Notes

### Preset Registry

Use a curated registry near the identity prompts instead of scanning `src/identities/` dynamically.

Each preset should include:

- `id`: stable lowercase slug used in commands and persisted data
- `label`: human-readable Telegram label
- `description`: one-line purpose for list replies
- `prompt`: raw markdown imported with `?raw`

This keeps prompt discovery explicit. `ECHO.md` can remain a sample/test prompt and should not become user-visible unless deliberately added to the registry.

### User Preference Storage

The selected preset can live on the existing `harness_users` row rather than in a separate preference table. Identity is a simple one-to-one user preference, so adding a nullable field such as `identity_id` to the user record is easier to reason about than introducing another store keyed by caller id.

Suggested behavior:

- `NULL` means "use the server default identity".
- `/identity use <preset>` writes the preset id onto the user.
- `/identity reset` clears the field.
- user lookup should return the identity id with the existing permission/access metadata.

If a stored id no longer exists in the registry, the runtime should fall back to the default preset and surface that in `/identity current`. This avoids blocking startup because an operator removed or renamed a preset. The stale field can be cleared opportunistically, but stale data should not prevent the user from using the bot.

### System-Prompt Boundary

Identity selection changes the system prompt, not just a cosmetic label. That creates a potentially confusing situation if the same LangGraph thread continues with prior messages produced under a different identity.

The feature should treat identity changes as an explicit prompt boundary:

- no in-flight turn is interrupted
- the user preference is persisted first
- the live session is rebuilt with the newly resolved identity prompt
- the active conversation moves to a fresh prompt context before the next normal user message

The safest user experience is to rotate the active thread when the preset changes, similar in spirit to `/new_thread`, because it prevents old identity instructions and old assistant behavior from being replayed as if they belong to the new identity. If continuity matters, the existing forced-checkpoint summary mechanism can carry neutral context across the boundary, but the new thread should be built with the new identity prompt.

This means `/identity use <preset>` should not merely mutate `session.identityId` inside the current agent instance. It should leave a clean operational state:

- selected identity stored on the user
- current session identity updated
- agent rebuilt from the selected identity prompt
- active thread id rotated or otherwise marked so old checkpoint messages are not replayed under the new prompt

The command reply should make the boundary visible, for example: "Identity switched to Research. Started a fresh context for this preset."

### Prompt Construction

`src/app.ts` currently imports `DO_IT.md` directly and passes it to `buildSystemPrompt`. Identity selection needs that default-only dependency moved behind a resolver. App-agent creation should receive the resolved identity prompt, or receive an identity id and resolve it through the registry before building the system prompt.

The memory prompt, runtime context, active task snapshot, and tool instructions stay identity-agnostic. The selected identity replaces only the identity prompt portion of the composed system prompt.

### Command Placement

The `/identity` command belongs with channel/session control commands, not permission commands. It should run only after the existing Telegram access check has resolved an active user.

Telegram should expose `/identity` in its command menu with a short description such as `Choose the bot identity preset`.

### Runtime Behavior

Identity command messages should not enter the agent's persisted message history as user chat. They are control actions with bot replies only.

The selected identity affects:

- future system prompt construction
- tool behavior only through changed model instructions
- memory usage rules only indirectly, because `memory_prompt.md` stays identity-agnostic

The selected identity should not affect:

- permissions
- pending approval resolution
- task store ownership
- active thread id
- attachment parsing
- timers or outbound channel routing

### Default identity and configuration

First iteration can use the current `DO_IT` prompt as the hardcoded default preset. A later iteration may add `DEFAULT_IDENTITY_ID` configuration if operators need deployment-specific defaults.

Avoid making default identity selection dependent on Telegram commands only. CLI and other channels should continue working with the default identity even if the identity store is absent from their command surface.

## Validation Expectations

Implementation tasks belong in `docs/plans/`, but this feature should eventually be validated against these observable outcomes:

- `/identity` returns current preset plus available choices.
- `/identity use <preset>` confirms the switch.
- A normal message after switching uses the new behavior.
- Bot restart keeps the caller's selected identity.
- `/identity reset` returns to the default behavior.
- Unknown `/identity use nope` does not change the active identity.
- Switching or resetting identity creates a fresh prompt context before the next normal turn.
- Identity command messages are not stored as ordinary user turns.

## Risks and Open Questions

- **Prompt-boundary semantics:** Automatically rotating context on identity change is less surprising than silently changing system prompts mid-thread, but it needs a clear confirmation reply so users understand why context may feel newly summarized or fresh.
- **Continuity across identity changes:** Carrying a neutral forced-checkpoint summary into the new identity context preserves useful project state. Starting completely fresh is simpler but more disruptive. The execution plan should choose one behavior deliberately.
- **Preset content quality:** The command framework can expose presets, but each preset still needs carefully written prompt text. Poorly differentiated prompts will make the feature feel unreliable.
- **Removed presets:** Persisted ids can become stale when operators edit the registry. Startup should fall back safely to default.
- **Configurable defaults:** Hardcoding `DO_IT` as default is enough for the first implementation. Add `DEFAULT_IDENTITY_ID` only if operators need it.
- **CLI parity:** The command can be channel-agnostic, but the user-facing requirement is Telegram. Decide during implementation whether CLI should expose `/identity` in its help output.
