# Plan: GoodKiddo Slice 2a — Fetch Card Renderer

> Parent roadmap: [`goodkiddo-v0-product-piece-slices.md`](./goodkiddo-v0-product-piece-slices.md)
>
> Feature scope: [`docs/features/goodkiddo-fetch-v0.md`](../features/goodkiddo-fetch-v0.md)

## Goal

Add one tiny, deterministic building block: a Fetch Card formatter.

This does **not** add `/fetch`, group routing, recent-chat context, scheduler, profile setup, or any new agent behavior. It only gives future Fetch work one compact Telegram-native output shape.

## User-visible shape

```text
🐶 Fetched
Noticed: [one concrete unfinished-business signal]
Prepared: [artifact type + short summary]
Missing: [one blocker only, or none]
Source: [direct ask / recent chat / forwarded case / public source]

[artifact body]
```

## Product rules

- Keep it compact enough for Telegram.
- `Noticed` must be concrete, not generic.
- `Prepared` must name the artifact type: draft, checklist, missing question, short research note, incident summary, or next-step card.
- `Missing` is either `none` or one blocker.
- No approval-flow language.
- No dangerous-action language: GoodKiddo prepares text only.

## Likely files

Verify exact paths before implementing.

- Create: `bot/src/capabilities/fetch/fetch_card.ts`
- Create: `bot/src/capabilities/fetch/fetch_card.test.ts`

## Task 1: Add Fetch Card formatter

- [ ] Create `FetchCardInput` with fields: `noticed`, `prepared`, `missing`, `source`, `body`.
- [ ] Create `formatFetchCard(input)`.
- [ ] Output starts with `🐶 Fetched`.
- [ ] Render labels exactly: `Noticed:`, `Prepared:`, `Missing:`, `Source:`.
- [ ] Render `Missing: none` when no blocker exists.
- [ ] Keep output plain Telegram-friendly Markdown; no tables.

Done when a deterministic Fetch Card can be formatted without calling the agent.

## Task 2: Test the formatter

- [ ] Test normal card formatting.
- [ ] Test `Missing: none` formatting.
- [ ] Test multiline body formatting.
- [ ] Test formatter does not add approval/action wording by itself.

Run:

```bash
cd bot && bun test src/capabilities/fetch/fetch_card.test.ts
cd bot && bun run typecheck
```

## Acceptance checklist

- [ ] No Telegram command behavior changes.
- [ ] No group/recent-context behavior changes.
- [ ] No scheduler, Morning Fetch, profile wizard, dashboard, or loop forms.
- [ ] Formatter output matches the Fetch Card shape.
- [ ] Tests and typecheck pass.
