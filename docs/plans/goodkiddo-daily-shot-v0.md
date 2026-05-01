# Plan: GoodKiddo Daily Shot v0

> Feature scope: [`docs/features/goodkiddo-daily-shot-v0.md`](../features/goodkiddo-daily-shot-v0.md)

## Overview

Build the first executable GoodKiddo v0 around Telegram business chats:

- GoodKiddo can sit in an existing Telegram group without replying to every normal business message.
- It stores recent chat flow as business context.
- It answers when directly asked.
- It can produce one manual `/daily_shot`.
- It later posts one weekday Daily Shot automatically.

This plan intentionally starts with the smallest demoable path: passive group capture + manual shot first, scheduler second. The product must bring prepared value, not ask noisy permission questions like “want a draft?”.

## Product boundaries

**In v0:**

- Telegram group/supergroup support.
- Passive recent-message capture for business context.
- Direct on-demand helper behavior when mentioned, replied to, or commanded.
- Business profile as one plain sentence.
- Manual `/daily_shot` trigger.
- Weekday automatic Daily Shot.
- Compact shot output: noticed signal, why it matters, prepared next move, source/context, missing critical info if any.

**Out of v0:**

- Multi-channel integrations.
- Dashboards.
- Full market research service.
- Calendar/reminder product positioning.
- Autonomous external sending/publishing/refunds/claims/liability decisions.
- Complex onboarding flows or forms.

## Existing code seams

Use these existing pieces instead of building a new app:

- `src/channels/telegram/handlers.ts` receives Telegram messages and starts the scheduler.
- `src/channels/telegram/turn.ts` owns Telegram command/direct-turn behavior.
- `src/channels/telegram/types.ts` owns Telegram command registration.
- `src/channels/shared.ts` and `src/app.ts` build agent sessions and prompts.
- `src/capabilities/timers/` already has durable scheduling patterns, but Daily Shot should have its own small module because it needs dynamic recent chat context, not just a static memory file.
- `src/memory/` already persists per-caller notes; use it for business profile only if needed by the agent, not as the source of truth for recent chat.
- `src/tools/factory.ts` already wires research/search tools for on-demand “little researcher” behavior.

## Validation Commands

Run from repo root unless a task says otherwise:

```bash
cd bot && bun test src/channels/telegram.test.ts
cd bot && bun test src/capabilities/daily_shot/*.test.ts
cd bot && bun test src/channels/telegram_daily_shot.test.ts
cd bot && bun run typecheck
cd bot && bun run lint
```

For docs-only changes to this plan:

```bash
git diff --check
```

## Output contract: Daily Shot

Every Daily Shot must be short and prepared:

```text
Daily Shot: <what GoodKiddo noticed>
Why: <one concrete business reason>
Prepared move: <draft/checklist/research note/next action>
Source: <recent chat/date/public source/confidence>
Missing: <only if a critical fact is needed>
```

Rules:

- Do not ask “want me to draft it?” when a safe draft/checklist is useful.
- Do ask when external action, liability, refund, claim submission, risky promise, or missing critical fact is involved.
- If evidence is weak, say confidence is low and make the prepared move safer.
- No long report unless the user explicitly asks.

---

### Task 1: Add passive Telegram group detection and direct-trigger rules

**Objective:** In group chats, GoodKiddo should watch quietly and only answer direct asks; in private chats, keep current behavior.

**Files:**

- Modify: `bot/src/channels/telegram/types.ts`
- Modify: `bot/src/channels/telegram/handlers.ts`
- Modify: `bot/src/channels/telegram/turn.ts`
- Test: `bot/src/channels/telegram.test.ts` or new `bot/src/channels/telegram_direct_trigger.test.ts`

**Steps:**

- [ ] Add `/daily_shot` to `TELEGRAM_COMMANDS` with description `Prepare today's business shot`.
- [ ] Add a helper such as `isTelegramGroupChat(ctx.chat.type)` returning true for `group` and `supergroup`.
- [ ] Add a helper such as `isDirectTelegramAsk(message, botUsername)` that returns true when:
  - message is in a private chat;
  - text starts with `/daily_shot` or another known command;
  - text mentions `@<bot username>`;
  - text starts with `GoodKiddo,` / `Good Kiddo,` / `Kiddo,`;
  - user replies to a bot message.
- [ ] In group/supergroup text handling, persist the message for context but do not call `handleTelegramQueuedTurn` unless `isDirectTelegramAsk(...)` is true.
- [ ] Strip only the bot mention prefix from direct asks before sending content to the agent; keep reply/forward context intact.
- [ ] Keep private DM behavior unchanged.
- [ ] Add tests proving normal group chatter is stored but does not invoke the agent, while direct mention does invoke it.

**Done when:** normal business chat messages do not create noisy bot replies, but direct questions still work.

---

### Task 2: Add a caller-scoped recent chat store

**Objective:** Persist recent Telegram business messages separately from agent thread history so Daily Shot can inspect normal group flow.

**Files:**

- Create: `bot/src/capabilities/daily_shot/chat_store.ts`
- Create: `bot/src/capabilities/daily_shot/chat_store.test.ts`
- Modify: `bot/src/channels/types.ts`
- Modify: `bot/src/channels/telegram/handlers.ts`

**Data model:**

Table: `daily_shot_chat_messages`

- `id` primary key
- `caller_id` text, e.g. `telegram:-100...`
- `chat_id` text, raw Telegram chat id
- `telegram_message_id` integer/text
- `sender_label` text nullable
- `text` text not null
- `kind` text: `text`, `photo_caption`, `document_caption`, `voice_transcript`, `system`
- `message_at` integer epoch milliseconds
- `created_at` integer epoch milliseconds

Indexes:

- `(caller_id, message_at DESC)`
- unique-ish `(caller_id, telegram_message_id)` where practical; if cross-dialect uniqueness is annoying, dedupe in code first.

**Steps:**

- [ ] Implement `DailyShotChatStore.ready()` with SQLite/Postgres-compatible table creation.
- [ ] Implement `recordMessage(input)` with compact text normalization and empty-text skip.
- [ ] Implement `listRecentMessages(callerId, { sinceMs?, limit })` returning newest-first or oldest-first consistently; prefer oldest-first for prompt rendering.
- [ ] Implement `pruneOldMessages(callerId, olderThanMs)`; default retention can be 14 days in caller code.
- [ ] Wire a store instance in Telegram runtime options for test injection, similar to `timerStore`.
- [ ] Record text messages before direct-trigger decision.
- [ ] Record useful captions from photos/documents; voice transcript storage can wait until Task 8 if not available cleanly.
- [ ] Add tests for create/list/order/dedupe/prune.

**Done when:** recent business chat context exists even for group messages GoodKiddo did not answer.

---

### Task 3: Add one-sentence business profile storage

**Objective:** Let the chat provide a minimal profile without forms or dashboard.

**Files:**

- Create: `bot/src/capabilities/daily_shot/settings_store.ts`
- Create: `bot/src/capabilities/daily_shot/settings_store.test.ts`
- Modify: `bot/src/channels/telegram/turn.ts`
- Modify: `bot/src/channels/telegram/types.ts`
- Modify: `bot/src/channels/README.md`

**Data model:**

Table: `daily_shot_settings`

- `caller_id` text primary key
- `business_profile` text nullable
- `enabled` integer default `1`
- `timezone` text default from `TIMEZONE`
- `post_hour_local` integer default `9`
- `created_at`, `updated_at` epoch ms

**Behavior:**

- `/business <one sentence>` sets the profile.
- `/business` shows the current profile and the exact command to replace it.
- Natural language profile capture can be prompt-driven later; deterministic command comes first.

**Steps:**

- [ ] Add `/business` to Telegram commands.
- [ ] Implement `DailyShotSettingsStore.getOrCreate(callerId, defaults)`.
- [ ] Implement `setBusinessProfile(callerId, profile)` with compact length cap around 280 chars.
- [ ] In Telegram command handling, intercept `/business` before the agent turn.
- [ ] Keep copy minimal: “Saved. I’ll use this for Daily Shot.”
- [ ] Add tests for set/show/replace and empty profile error.

**Done when:** a group can say `/business We are a courier company in Prague` and Daily Shot has stable business context.

---

### Task 4: Build the Daily Shot prompt renderer and selector contract

**Objective:** Create deterministic prompt assembly for a single compact business shot from profile + recent messages.

**Files:**

- Create: `bot/src/capabilities/daily_shot/prompt.ts`
- Create: `bot/src/capabilities/daily_shot/prompt.test.ts`
- Create: `bot/src/capabilities/daily_shot/types.ts`

**Prompt inputs:**

- business profile;
- current date/time/timezone;
- recent message digest, capped by count and character budget;
- trigger: `manual` or `scheduled`;
- safety/output contract.

**Steps:**

- [ ] Export `renderDailyShotPrompt(input)`.
- [ ] Render messages oldest-first with timestamp and sender label when available.
- [ ] Cap transcript length before returning prompt; do not rely on model context limits.
- [ ] Include explicit instruction: choose exactly one best shot or say `No useful shot today` only if there is truly no signal.
- [ ] Include explicit instruction: prepare draft/checklist/research note when useful; do not ask permission to draft.
- [ ] Include safety boundary for external actions, refunds, liability, medical/legal, and low evidence.
- [ ] Add snapshot-ish tests for no profile, no messages, noisy messages, complaint messages, and pricing/competitor messages.

**Done when:** Daily Shot prompt is stable, test-covered, and product-aligned without needing hidden context.

---

### Task 5: Implement manual `/daily_shot`

**Objective:** Produce the first demoable Daily Shot on demand before adding automatic scheduling.

**Files:**

- Create: `bot/src/capabilities/daily_shot/run.ts`
- Create: `bot/src/capabilities/daily_shot/run.test.ts`
- Modify: `bot/src/channels/telegram/turn.ts`
- Modify: `bot/src/channels/telegram/handlers.ts`
- Test: `bot/src/channels/telegram_daily_shot.test.ts`

**Steps:**

- [ ] Implement `buildDailyShotInput({ callerId, now, stores, config })` that loads settings and recent messages.
- [ ] Implement `runDailyShotForSession(session, input)` that:
  - sets `session.currentUserText` to the rendered Daily Shot prompt;
  - sets `session.currentTurnContext.source` to `system_clock` or a new `daily_shot` source if added;
  - refreshes the agent;
  - invokes/streams the agent using existing `buildInvokeMessages` pattern;
  - returns final text.
- [ ] Intercept `/daily_shot` command and call this runner.
- [ ] Send one Telegram message with the result; reuse existing Telegram chunking.
- [ ] If no business profile exists, still run but include “business profile missing” in prompt; do not block the user.
- [ ] Add tests with fake stores and fake agent session proving the command renders prompt and sends output.

**Done when:** Nick can manually trigger a real Daily Shot in a Telegram group using recent passive chat context.

---

### Task 6: Add automatic weekday Daily Shot scheduler

**Objective:** Post one Daily Shot every weekday without the user setting a generic timer.

**Files:**

- Create: `bot/src/capabilities/daily_shot/scheduler.ts`
- Create: `bot/src/capabilities/daily_shot/scheduler.test.ts`
- Modify: `bot/src/channels/types.ts`
- Modify: `bot/src/channels/telegram/handlers.ts`
- Modify: `bot/src/config.ts`
- Test: `bot/src/channels/telegram_daily_shot.test.ts`

**Config:**

- `ENABLE_DAILY_SHOT`, default `true` for Telegram entrypoint.
- `DAILY_SHOT_INTERVAL_MS`, default `60000`.
- `DAILY_SHOT_DEFAULT_HOUR`, default `9`.

**Data model addition:**

Add to `daily_shot_settings` or a separate `daily_shot_runs` table:

- `last_run_local_date` text (`YYYY-MM-DD`) per caller;
- `last_run_at` epoch ms;
- `last_error` text nullable;
- `consecutive_failures` integer.

**Steps:**

- [ ] Scheduler polls enabled settings once per minute.
- [ ] It runs only Monday-Friday in each setting timezone.
- [ ] It runs once per local date after `post_hour_local`.
- [ ] It calls the same runner as `/daily_shot` with trigger `scheduled`.
- [ ] It records success/failure so restarts do not double-post.
- [ ] On repeated failure, notify the chat once with a compact internal-error line; do not spam every minute.
- [ ] Start/stop scheduler beside the existing timer scheduler in `telegramChannel.run()`.
- [ ] Add tests for weekday/weekend, timezone date boundary, once-per-day idempotency, and retry/failure behavior.

**Done when:** Daily Shot posts automatically on weekdays and does not duplicate on restart.

---

### Task 7: Update GoodKiddo identity and welcome copy for product v0

**Objective:** Stop presenting GoodKiddo as a generic coding helper; make behavior match Daily Shot + on-demand chat helper.

**Files:**

- Modify: `bot/src/identities/GOOD_KIDDO.md`
- Modify: `bot/src/identities/registry.ts` if preset descriptions need adjustment
- Modify: `bot/src/channels/telegram/turn.ts`
- Modify: `bot/src/identities/README.md`
- Test: `bot/src/identities/registry.test.ts` if descriptions/registry change

**Prompt requirements:**

- GoodKiddo is a friendly business dog in a Telegram business chat.
- It watches quietly in group chats.
- It answers direct questions.
- It prepares drafts/checklists/summaries/research notes when safe.
- It does not take over final external actions.
- It keeps replies compact for Telegram.
- It uses tools when needed for on-demand little research.

**Steps:**

- [ ] Rewrite `GOOD_KIDDO.md` around the accepted v0 product promise.
- [ ] Keep safety boundaries explicit.
- [ ] Remove coding-first examples from default prompt or move them to another preset if still needed.
- [ ] Update `/start` welcome to say:
  - add me to the business chat;
  - set `/business <one sentence>`;
  - ask me directly when needed;
  - use `/daily_shot` for a manual shot.
- [ ] Ensure no copy says GoodKiddo is a reminder/calendar app.

**Done when:** the product no longer feels like “Hermes for normal people”.

---

### Task 8: Include attachment-derived business context where cheap

**Objective:** Make photos/captions/documents useful for shots without building a full ops desk.

**Files:**

- Modify: `bot/src/channels/telegram/handlers.ts`
- Modify: `bot/src/capabilities/daily_shot/chat_store.ts`
- Test: `bot/src/channels/telegram_daily_shot.test.ts`

**Steps:**

- [ ] Store photo captions and document filenames/captions as recent context.
- [ ] Store voice transcript snippets only if the existing voice pipeline exposes text at the right seam without major refactor.
- [ ] Do not store raw binary/image data in Daily Shot store.
- [ ] Cap attachment-derived text aggressively.
- [ ] Add tests proving caption-only context can appear in Daily Shot prompt.

**Done when:** common Telegram business evidence like “parcel damaged” photo captions can influence Daily Shot.

---

### Task 9: Add a small demo script and acceptance checklist

**Objective:** Make the MVP demo repeatable for review.

**Files:**

- Create: `docs/demos/goodkiddo-daily-shot-v0.md`
- Modify: `docs/features/goodkiddo-daily-shot-v0.md` only if acceptance criteria need a link

**Demo scenario:**

1. Add bot to a Telegram test group.
2. Set `/business We are a courier company in Prague`.
3. Send normal group messages:
   - “Anna asked for price, I’ll send tomorrow.”
   - “Parcel 123 damaged, customer angry, photos attached.”
   - “Competitor looks cheaper this week.”
4. Confirm GoodKiddo does not reply to normal chatter.
5. Ask `GoodKiddo, summarize parcel 123` and confirm on-demand answer.
6. Run `/daily_shot` and confirm one compact prepared shot.
7. Move scheduler clock/config or wait until weekday run and confirm no duplicate post.

**Done when:** a reviewer can validate the v0 promise without reading the code.

---

## Implementation order

Recommended PR sequence:

1. Passive group capture + direct-trigger rules: Tasks 1–2.
2. Business profile + manual Daily Shot: Tasks 3–5.
3. Automatic weekday scheduler: Task 6.
4. Product prompt/welcome polish: Task 7.
5. Attachment context + demo docs: Tasks 8–9.

Do not start with the scheduler. Manual `/daily_shot` is the fastest proof that the product loop is correct.

## Review checklist

- [ ] Normal group chatter does not cause bot replies.
- [ ] Direct mention/reply still gets an answer.
- [ ] `/business` stores exactly one sentence of business context.
- [ ] `/daily_shot` uses recent passive messages, not only prior agent conversation.
- [ ] Daily Shot output includes a prepared next move.
- [ ] No “want me to draft?” behavior in the shot.
- [ ] Scheduler posts at most once per weekday per chat.
- [ ] Safety boundaries are visible in prompt and behavior.
- [ ] No dashboard or multi-channel scope appears in implementation.
