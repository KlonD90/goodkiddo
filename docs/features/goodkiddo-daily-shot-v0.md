# GoodKiddo v0: Daily Shot

## Scope in one sentence

Add GoodKiddo to a Telegram business chat; every weekday it reads the recent business flow and prepares one concrete next move.

## Product promise

GoodKiddo is not a calendar. It is a friendly business dog in the chat that brings one useful thing each workday: a draft, a checklist, a small research note, or a clear next action.

It should still answer normal questions in chat when people ask it directly. Daily Shot is the proactive habit, not the whole product. On demand, GoodKiddo can be a small researcher and business helper: explain, summarize, compare, draft, check public sources, and turn messy context into a practical answer.

## Why this v0

Reminders are weak. Small businesses already have calendars and alarms. GoodKiddo should not win by saying “remember tomorrow”. It should win by doing useful preparation before it speaks.

The visible habit should be:

> GoodKiddo checks the chat, picks the best shot, and brings the next move.

## User setup

The user should do only two things:

1. Add GoodKiddo to the Telegram business chat.
2. Say one plain sentence about the business, for example:
   - “We are a courier company in Prague.”
   - “I run a lash studio in Busan.”
   - “We sell home cleaning services in London.”

No forms. No dashboard. No manual loop creation.

## On-demand chat help

GoodKiddo should also respond when someone asks it directly in the Telegram chat. This keeps the useful assistant behavior users already expect.

On-demand examples:

- “GoodKiddo, how should we answer this customer?”
- “GoodKiddo, summarize what happened with this order.”
- “GoodKiddo, check this competitor page.”
- “GoodKiddo, what price should we try?”
- “GoodKiddo, make a short checklist for this case.”

When asked directly, GoodKiddo should answer immediately with a useful draft, summary, checklist, or small research note. It should still follow the same safety boundary: prepare and explain, but do not take final external action.

This on-demand mode is intentionally small. It is not a full agent workspace or enterprise research suite. It is the chat-native helper mode that supports Daily Shot.

## Daily Shot behavior

Every weekday, GoodKiddo should inspect recent chat context and post one compact business shot.

A Daily Shot contains:

1. **What GoodKiddo noticed** — the business signal from chat, an explicit user question, or a lightweight check.
2. **Why it matters** — one short reason.
3. **Prepared next move** — draft, checklist, summary, offer, or research note.
4. **Source/context** — enough context to trust it.

GoodKiddo should not ask “want me to draft it?” If a safe draft is useful, it drafts it.

## Examples

### Follow-up shot

Chat signal:

> “Anna asked for price, I’ll send tomorrow.”

Daily Shot:

> **Daily Shot:** Anna’s price reply is still open.  
> **Why:** she is a warm lead and the chat has no sent reply.  
> **Draft:** “Hi Anna, here’s the price we discussed…”  
> Source: yesterday’s chat.

### Objection shot

Chat signal:

> Two people said the offer is expensive this week.

Daily Shot:

> **Daily Shot:** “Too expensive” came up twice this week.  
> **Why:** this may be a packaging problem, not just price.  
> **Prepared move:** test a smaller starter package: “Basic visit from €X.”  
> Source: two recent customer replies.

### Competitor/pricing shot

Chat signal:

> “Competitor looks cheaper.”

Daily Shot:

> **Daily Shot:** I checked visible competitor prices.  
> **Why:** your basic package seems above the local visible range.  
> **Prepared move:** try positioning around faster response / safer delivery instead of discounting.  
> Source: 4 public competitor pages; confidence: directional.

### Ops shot

Chat signal:

> “Parcel damaged, customer angry.”

Daily Shot:

> **Daily Shot:** damaged parcel case needs a clean customer update.  
> **Why:** the chat has photos but no final customer message.  
> **Draft:** “I’m sorry the parcel arrived damaged. We’re checking this now…”  
> Missing: final delivery/order status.

## What GoodKiddo may prepare

- customer reply draft;
- follow-up draft;
- short checklist;
- business summary;
- offer/pricing suggestion;
- competitor/pricing mini-note;
- unresolved issue summary;
- one recommended action for today.

## What GoodKiddo should avoid

- noisy permission questions;
- generic reminders;
- long reports;
- dashboards;
- pretending to know more than the evidence supports;
- sending risky external messages by itself;
- making refunds, liability decisions, claims, or business commitments.

## Immediate vs daily posting

Default: one weekday Daily Shot.

Immediate posts are allowed only when high-confidence and high-value, for example:

- customer complaint needs a neutral reply;
- safety/incident language appears;
- a concrete promise was made with a near deadline;
- someone explicitly mentions GoodKiddo or asks for help.

Even immediate posts should bring prepared value, not ask “want help?”

## Safety boundary

GoodKiddo cannot fail the user because it cannot take over.

It prepares, checks, drafts, summarizes, and suggests. The human still sends, approves, refunds, escalates, changes prices, or makes final business decisions.

## v0 product rules

1. Bring value before asking.
2. One shot beats ten nudges.
3. Draft when safe; ask only for missing critical facts or final external action.
4. Use chat context first.
5. Be honest about evidence and confidence.
6. Keep it short enough for Telegram.
7. Human owns the final call.

## MVP implementation scope

In scope:

- Telegram group chat context.
- One-sentence business profile.
- Recent-message scanner.
- Daily Shot selector.
- Draft/checklist/research-note generator.
- On-demand direct-question answers in chat.
- Small researcher mode for public-source checks when explicitly requested.
- Artifact link or compact preview.
- Basic source/context references.
- Weekday schedule.
- Manual trigger for testing, e.g. `/daily_shot`.

Out of scope:

- calendar-style reminder product;
- full market research service, beyond small on-demand checks and Daily Shot notes;
- full ops desk;
- multi-channel integrations;
- dashboards;
- paid panels;
- autonomous external actions;
- complex CRM.

## Success test

GoodKiddo v0 works if a real small-business chat can ignore it most of the day, then once per weekday receive something that feels like:

> “Okay, that was actually useful. I can use this now.”
