# Plan: GoodKiddo Slice 1 — Quiet Telegram Group Watcher

> Parent roadmap: [`goodkiddo-daily-shot-v0.md`](./goodkiddo-daily-shot-v0.md)

## Goal

Let GoodKiddo join a Telegram business group, capture useful recent chat context, and stay quiet unless someone directly asks it for help.

## User-visible behavior

- In private DM: GoodKiddo behaves as it does today.
- In group/supergroup: normal business messages do not trigger an agent reply.
- In group/supergroup: GoodKiddo answers when directly addressed.
- Captured group messages become available for later Daily Shot slices.

## Direct ask rules

GoodKiddo should answer in a group when one of these is true:

- message is a supported slash command;
- message mentions the bot username, e.g. `@goodkiddo_bot summarize this`;
- message starts with `GoodKiddo,`, `Good Kiddo,`, or `Kiddo,`;
- user replies to a previous bot message.

Everything else is passive context only.

## Files

- Modify: `bot/src/channels/telegram/types.ts`
- Modify: `bot/src/channels/telegram/handlers.ts`
- Modify: `bot/src/channels/telegram/turn.ts`
- Create: `bot/src/capabilities/daily_shot/chat_store.ts`
- Create: `bot/src/capabilities/daily_shot/chat_store.test.ts`
- Test: `bot/src/channels/telegram.test.ts` or `bot/src/channels/telegram_group_watcher.test.ts`

## Validation Commands

```bash
cd bot && bun test src/capabilities/daily_shot/chat_store.test.ts
cd bot && bun test src/channels/telegram.test.ts
cd bot && bun run typecheck
```

## Task 1: Add recent chat store

- [ ] Create `src/capabilities/daily_shot/chat_store.ts`.
- [ ] Add table `daily_shot_chat_messages` with fields:
  - `id`
  - `caller_id`
  - `chat_id`
  - `telegram_message_id`
  - `sender_label`
  - `text`
  - `kind`
  - `message_at`
  - `created_at`
- [ ] Add indexes for `(caller_id, message_at DESC)`.
- [ ] Implement `recordMessage(input)`.
- [ ] Implement `listRecentMessages(callerId, { limit })` returning oldest-first for prompt use.
- [ ] Implement `pruneOldMessages(callerId, olderThanMs)`.
- [ ] Add tests for create/list/order/empty text/prune.

Done when the store can hold recent group text without involving the agent thread.

## Task 2: Detect group vs private chat

- [ ] Add a small helper near Telegram handlers or types:
  - private chat: normal current behavior;
  - `group` / `supergroup`: passive-by-default behavior.
- [ ] Add tests for private, group, supergroup.

Done when handlers can branch by chat type without changing behavior yet.

## Task 3: Record passive group text

- [ ] Instantiate/inject `DailyShotChatStore` in `telegramChannel.run()`.
- [ ] Record every non-empty group/supergroup text message before any direct-trigger decision.
- [ ] Include sender label when safely available: username, first name, or Telegram user id.
- [ ] Store message timestamp from Telegram message date.
- [ ] Do not store raw files or binary data.
- [ ] Keep forwarded command safety unchanged: forwarded slash commands must not execute.

Done when normal group chatter is persisted and the bot still does not reply.

## Task 4: Add direct ask detection

- [ ] Implement `isDirectTelegramAsk(message, botUsername)`.
- [ ] Direct ask if command, bot mention, GoodKiddo prefix, or reply-to-bot.
- [ ] Strip bot mention / GoodKiddo prefix from the user-visible command text where needed.
- [ ] Preserve reply/forward context block behavior.
- [ ] In group/supergroup, skip `handleTelegramQueuedTurn` unless direct ask is true.
- [ ] In private DM, preserve current behavior.

Done when group direct asks work and normal chatter stays silent.

## Task 5: Minimal command registration prep

- [ ] Add `/daily_shot` to Telegram commands as a known command, but it may return a short “Daily Shot is not implemented yet” placeholder in this slice.
- [ ] Do not implement the Daily Shot generator in this slice.

Done when `/daily_shot` is reserved for Slice 2 without expanding this PR.

## Acceptance checklist

- [ ] Normal group text is stored but produces no bot reply.
- [ ] `GoodKiddo, summarize this` invokes the agent.
- [ ] `@bot_username summarize this` invokes the agent.
- [ ] Replying to a bot message invokes the agent.
- [ ] Private DM behavior is unchanged.
- [ ] Forwarded slash commands still do not execute.
- [ ] Tests and typecheck pass.
