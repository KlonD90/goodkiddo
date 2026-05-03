# GoodKiddo v0: Fetch

## Scope in one sentence

Add GoodKiddo to a Telegram business chat so it works out of the box: the doggo reads messy chat/direct asks/forwarded cases and brings back one useful draft, checklist, missing question, or short research note.

## Product promise

GoodKiddo is a smart business dog in Telegram.

It does not start as an empty workflow builder. It should be useful before setup: when a user drops it into a chat, mentions it, replies to it, or forwards a messy situation, GoodKiddo should infer the likely help needed and bring back a compact useful artifact.

Business profile, memory, quiet group watching, and scheduled habits make the dog sharper. They are not prerequisites for first value.

## Product pieces in this v0

GoodKiddo is the sum of product pieces. No single piece should take over the product.

- **Smart out of the box** — doggo can infer helpful next steps from messy input before configuration.
- **Fetch** — doggo brings back a useful artifact, not another question-first chatbot turn.
- **Useful before asking** — ask only for blockers or critical missing info.
- **Small artifact** — one draft, checklist, missing question, research note, incident summary, or next-step card.
- **Telegram-native** — GoodKiddo lives where the business chat already happens.
- **Business nose** — GoodKiddo notices unfinished business signals and messy situations.
- **No dangerous hands** — wrong output is just draft text; GoodKiddo does not send, spend, post, book, publish, or act externally as the user.
- **Friendly business dog** — calm, observant, loyal, non-bossy; doggo behavior is product behavior, not decoration.

## Out-of-box behavior

GoodKiddo should already help when a user gives it messy context:

- “GoodKiddo, how should we answer this customer?”
- “GoodKiddo, summarize what happened with this order.”
- “GoodKiddo, check this competitor page.”
- “GoodKiddo, what price should we try?”
- “GoodKiddo, make a short checklist for this case.”
- Forwarded screenshots/messages/captions when supported by the channel.

Expected output shape:

```text
🐶 Fetched
Noticed: [one concrete signal]
Prepared: [draft/checklist/question/research note]
Missing, if any: [one blocker only]
Source: [chat/direct ask/forwarded case/public source]
```

This is not approval flow. Users can use, edit, forward, reply with, or ignore what GoodKiddo brings back.

## Setup should sharpen, not unlock

The first user setup may be tiny:

1. Add GoodKiddo to the Telegram chat, or DM/forward it a messy case.
2. Optionally say one plain sentence about the business, for example:
   - “We are a courier company in Prague.”
   - “I run a lash studio in Busan.”
   - “We sell home cleaning services in London.”

No forms. No dashboard-first flow. No manual loop creation.

## Group behavior

In a Telegram group, GoodKiddo should be quiet by default.

It should not reply to every normal business message. It should answer when directly addressed by mention, reply, supported command, or clear GoodKiddo prefix.

Quiet does not mean dumb. Normal chat can become context for later Fetch behavior when storage is implemented.

## Scheduled habit

A scheduled Morning Fetch can exist later, but it is not the center of the product.

Scheduled Fetch should only come after manual/out-of-box Fetch is useful. The habit is a delivery surface for Fetch, not the product itself.

## Boundaries

GoodKiddo can:

- draft replies;
- summarize messy situations;
- prepare checklists;
- extract missing questions;
- produce short research notes;
- prepare calm incident/customer messages;
- suggest a next safe step.

GoodKiddo must not:

- send emails;
- move money or crypto;
- post externally;
- publish;
- buy;
- book;
- sign;
- submit forms/claims;
- promise refunds or admit liability;
- act as the user outside Telegram.

## Naming notes

Use:

- GoodKiddo Fetch
- Fetch
- Fetch Card
- Morning Fetch for a later scheduled habit

Do not treat old names like Daily Shot as banned words. Treat them as old working labels/examples unless explicitly promoted again.
