# Plan: GoodKiddo v0 Implementation Slices

> Feature scope: [`docs/features/goodkiddo-daily-shot-v0.md`](../features/goodkiddo-daily-shot-v0.md)

## Why this is split

The full v0 has too many moving parts for one agent pass. We should build it as small, reviewable slices that each prove one product behavior.

Core direction stays the same:

- GoodKiddo lives in a Telegram business chat.
- It watches normal business flow without replying to every message.
- It answers when directly asked.
- It prepares one useful Daily Shot instead of acting like a reminder/calendar app.
- It does not take final external actions.

## Slice order

### Slice 1: Quiet Telegram group watcher

Goal: GoodKiddo can sit in a group without creating noise.

Build:

- detect group/supergroup vs private chat;
- store normal group text as business context;
- only answer direct asks: mention, reply-to-bot, command, or DM;
- keep existing DM behavior unchanged.

Plan: [`goodkiddo-slice-1-quiet-group-watcher.md`](./goodkiddo-slice-1-quiet-group-watcher.md)

### Slice 2: Business profile + manual shot

Goal: prove the product loop manually before any scheduler.

Build:

- `/business <one sentence>`;
- Daily Shot prompt renderer;
- `/daily_shot` command using recent passive chat context;
- compact output contract: noticed / why / prepared move / source.

### Slice 3: Weekday automatic Daily Shot

Goal: turn the manual shot into the weekday habit.

Build:

- Daily Shot settings and run history;
- weekday/timezone scheduler;
- once-per-local-day guard;
- failure throttling.

### Slice 4: Product identity and demo polish

Goal: make the running bot feel like GoodKiddo, not generic Hermes.

Build:

- rewrite default GoodKiddo prompt around business dog behavior;
- update `/start` copy;
- add demo script and acceptance checklist;
- include cheap attachment/caption context if the seam is already simple.

## Rule for implementation PRs

One implementation PR should cover only one slice. If a slice starts growing, split it again.

## First PR to implement

Start with Slice 1 only.

Why:

- If the bot is noisy in a business group, the product fails immediately.
- Passive capture is prerequisite for Daily Shot.
- Direct asks preserve on-demand helper value.
- No scheduler or AI prompt work is needed to validate this first behavior.
