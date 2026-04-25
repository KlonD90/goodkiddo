# Plan: Telegram Welcome Message

## Overview

Add a Telegram `/start` onboarding reply. The command should explain how to begin using the assistant without invoking the agent, changing thread state, or entering conversation history.

## DoD

**Welcome behavior:**

1. `/start` returns a concise welcome message for authorized Telegram users.
2. The message tells users they can write normal requests, send supported files, choose an identity with `/identity`, and start fresh with `/new_thread`.
3. `/start` does not invoke the agent and does not enqueue a turn.
4. `/start` does not enter stored conversation history.
5. A first-time Telegram chat can receive the welcome message after normal caller resolution or free-tier provisioning.

**Command registration:**

1. Telegram command registration includes `/start`.
2. The command description is short enough for the Telegram command menu.

## Validation Commands

- `bun tsc --noEmit`
- `bun test src/channels/telegram.test.ts`
- `bun test src/channels/session_commands.test.ts`

---

### Task 1: Define the welcome reply
- [x] Add a small helper for rendering the Telegram welcome message.
- [x] Keep the message static and direct; do not call the model.
- [x] Mention plain-language requests, supported files, `/identity`, and `/new_thread`.
- [x] Keep the helper easy to test without constructing a full Telegram bot.
- [x] Add focused tests for message content if the helper is exported.

### Task 2: Register and handle `/start`
- [x] Add `start` to `TELEGRAM_COMMANDS` with a concise description.
- [x] Handle direct `/start` after `resolveContext` succeeds in the Telegram text-message path.
- [x] Send the welcome reply directly with `sendTelegramMessage`.
- [x] Do not call `handleTelegramQueuedTurn` for `/start`.
- [x] Keep caller resolution before the welcome reply so free-tier provisioning can happen first when that feature is present.
- [x] Decide whether `/start@BotName` should normalize the same way as other Telegram commands and cover it if supported.

### Task 3: Preserve runtime invariants
- [x] Add tests proving `/start` does not invoke the agent.
- [ ] Add tests proving `/start` does not enqueue a turn while a session is running.
- [ ] Add tests proving first-time `/start` follows the expected caller-resolution path.
- [x] Add tests proving `/start` is not treated as an unknown slash command.
- [ ] Add a regression check that `/help`, `/identity`, and `/new_thread` behavior is unchanged.

### Task 4: Update docs and final validation
- [x] Update `src/channels/README.md` with `/start` onboarding behavior.
- [x] Update `README.md` only if the public usage section should mention `/start`.
- [ ] Run all validation commands listed above.
- [ ] Mark tasks complete only after implementation and tests pass.
