# Plan: GoodKiddo v0 Product-Piece Slices

> Feature scope: [`docs/features/goodkiddo-fetch-v0.md`](../features/goodkiddo-fetch-v0.md)

## Why this is split

GoodKiddo v0 has multiple product pieces. We should build it as small, reviewable slices that each prove one or two pieces without overfitting those pieces into the whole product.

Core direction:

- GoodKiddo is the sum of product pieces.
- Doggo should be smart out of the box; setup improves quality but should not be required for first value.
- Fetch is the core behavior: bring a useful draft/checklist/question/research note from messy business context.
- GoodKiddo lives in Telegram and stays quiet unless useful or directly addressed.
- GoodKiddo has no dangerous hands: it prepares text/artifacts, not external actions.

## Slice order

### Slice 0: Smart doggo baseline

Goal: lock the common product baseline all future slices depend on.

Build:

- default GoodKiddo prompt/contract around smart out-of-box Fetch behavior;
- compact artifact output shape: noticed / prepared / missing / source;
- safety boundary: draft-only, no external actions;
- direct messy-case response examples and acceptance checks;
- docs that make “product pieces” the roadmap unit.

Done when GoodKiddo can be evaluated by this promise:

> Drop a messy business case into Telegram; doggo brings back something useful without demanding workflow setup first.

### Slice 1: Quiet Telegram group presence

Product pieces: Telegram-native, friendly business dog, no noise.

Goal: GoodKiddo can sit in a Telegram business group without barking at every message.

Build:

- detect group/supergroup vs private chat;
- keep normal group messages passive-by-default;
- answer only direct asks: mention, reply-to-bot, supported command, or GoodKiddo prefix;
- preserve existing DM behavior;
- prepare recent-chat storage for later Fetch surfaces.

Plan: [`goodkiddo-slice-1-quiet-group-watcher.md`](./goodkiddo-slice-1-quiet-group-watcher.md)

### Slice 2a: Fetch Card renderer

Product pieces: Fetch, small artifact, no dangerous hands.

Goal: create one deterministic Fetch Card output shape before adding new Telegram behavior.

Build:

- `formatFetchCard` helper;
- tests for normal card, `Missing: none`, multiline body, and no approval/action wording;
- no `/fetch` command, group routing, recent-context lookup, scheduler, profile, dashboard, or loop forms.

Plan: [`goodkiddo-slice-2a-fetch-card-renderer.md`](./goodkiddo-slice-2a-fetch-card-renderer.md)

### Slice 2b: Manual `/fetch` command

Product pieces: Fetch, smart out of the box, useful before asking, Telegram-native.

Goal: make the formatter callable from a tiny manual surface.

Build later:

- `/fetch` with direct text in DM;
- one Fetch Card through the existing agent flow;
- one blocker question max when critical info is missing;
- no group/recent-context behavior until a later slice.

### Slice 3: Better business nose

Product pieces: business nose, invisible loop engine.

Goal: improve GoodKiddo’s ability to notice unfinished business signals in recent chat.

Build:

- detect unanswered asks, promised follow-ups, stale decisions, missing price/date/spec, customer tension, and messy incidents;
- rank one best candidate for Fetch;
- keep loop/case concepts internal, not user-facing forms.

### Slice 4: Business profile sharpener

Product pieces: useful context, pain-point intake.

Goal: allow a tiny business profile to improve Fetch quality without becoming onboarding hell.

Build:

- `/business <one sentence>` or equivalent tiny profile capture;
- profile-aware Fetch prompt context;
- edit/replace behavior;
- no multi-step configuration wizard.

### Slice 5: Morning Fetch habit

Product pieces: Fetch habit, Telegram-native delivery.

Goal: add scheduled Morning Fetch only after manual/out-of-box Fetch is useful.

Build:

- settings and run history;
- weekday/timezone scheduler;
- once-per-local-day guard;
- failure throttling;
- Morning Fetch output using the same Fetch Card contract.

## Rule for implementation PRs

One implementation PR should cover only one slice. If a slice starts growing, split it again.

Slices are engineering delivery units, not product intelligence limits. Doggo should not feel dumb until later slices; later slices sharpen or automate useful behavior that should already exist in seed form.

## First PR to implement

Start with Slice 0/1 boundary work:

1. lock the Smart doggo baseline in docs/prompt acceptance criteria;
2. implement quiet Telegram group presence without building scheduler/profile flow.

Why:

- If GoodKiddo is noisy in a business group, the product fails immediately.
- If GoodKiddo needs setup before helping, the product feels like empty workflow software.
- Direct asks preserve out-of-box helper value.
- Scheduler/profile work should wait until Fetch is useful manually.
