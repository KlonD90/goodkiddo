# GoodKiddo Maintainability Writing Standard

This is the canonical writing standard for GoodKiddo. It is for humans and coding agents alike.

The goal is readable, maintainable code first. Bot-friendly structure is a strong secondary goal because predictable code is easier to review, refactor, and automate.

## What GoodKiddo Code Looks Like

- One file should have one clear job.
- One function should do one kind of work.
- Orchestration should read top-to-bottom without forcing the reader to mentally execute every branch.
- Domain language should be explicit. Prefer `PairedTask`, `ServiceHandoff`, and `RoomMode` over generic names like `item`, `data`, or `state`.
- Pure logic should be easy to test without booting channels, runners, or databases.
- Side effects should sit at the edges: process spawning, DB writes, network I/O, filesystem access, timers, and platform APIs.
- Comments should explain intent, invariants, or non-obvious constraints. Do not narrate obvious mechanics.

## Core Rules

### 1. Write for Scanability

Optimize for the first read:

- Keep file layout predictable: imports, exported types, exported entrypoints, private helpers.
- Prefer early returns over deeply nested conditionals.
- Keep variable scope tight and names specific.
- Pull named helpers out of long inline branches when the branch has a purpose worth naming.
- Keep “why” close to the code when behavior is surprising or constrained by platform details.

### 2. Keep Responsibilities Separated

Do not combine unrelated work in the same function or file.

- Transport and platform semantics belong in channel adapters.
- Runtime modules should orchestrate work and delegate rule-heavy logic to focused helpers.
- Persistence modules should own storage concerns, not routing or platform behavior.
- Shared helpers should stay small and stable. `shared/` is not a dumping ground for code with no obvious home.
- When a module starts mixing policy, formatting, I/O, and lifecycle management, split it.

### 3. Prefer Explicit Data Flow

- Pass dependencies and values directly instead of relying on hidden mutation.
- Keep state ownership obvious. A reader should know which module creates, updates, and consumes a piece of state.
- Prefer typed objects with named fields over positional parameters once a call carries domain meaning.
- Avoid “magic” helper chains that hide control flow or mutate inputs unexpectedly.

### 4. Keep Pure Logic Testable

- Extract parsing, normalization, filtering, and decision logic into helpers that can be tested in isolation.
- Keep I/O wrappers thin when possible.
- If a function both decides and performs side effects, split the decision from the effect unless doing so would make the code less clear.

### 5. Optimize for Bot Readability Too

Coding agents work better when the repo shape is predictable.

- Keep entrypoints obvious and documented.
- Prefer small, named helpers over long anonymous blocks.
- Use stable naming and consistent file placement for similar responsibilities.
- Avoid hidden coupling across distant files.
- Update nearby READMEs when folder boundaries or reading order change.

## Review Triggers

These are not automatic failure rules, but they do require an explicit maintainability review.

### Large File Trigger

- Existing files should usually stay under roughly 400-500 lines unless they are mostly schema, fixtures, or another clearly justified format.
- New files should aim well below that range.
- If a file grows past the range, explain why it should remain whole or split it before merging.

### Large Function Trigger

- Review any function that is long enough that a reader must scroll repeatedly to understand one unit of behavior.
- Split functions that mix orchestration with parsing, formatting, validation, or persistence details.

### Multi-Responsibility Trigger

Refactor when one module starts owning multiple concerns such as:

- transport plus domain policy,
- persistence plus formatting,
- orchestration plus low-level parsing,
- lifecycle management plus unrelated business rules.

### Hidden-State Trigger

Refactor when behavior depends on:

- implicit globals,
- cross-module mutation,
- unclear ownership of timers, cursors, leases, or sessions,
- data transformations that are hard to trace from input to output.

## GoodKiddo-Specific Expectations

### `src/runtime/`

- Runtime files should orchestrate turns, queueing, and delivery.
- Rule-heavy logic belongs in focused helpers, not inline inside the main loop.
- Runtime should depend on clear interfaces from `channels/`, `agents/`, `paired/`, and `persistence/`.

### `src/persistence/`

- Split storage code by domain or capability when a single module becomes a grab bag.
- Keep schema, migrations, and query helpers understandable without reading the whole file at once.
- Persistence helpers should return clear domain shapes and keep SQL-specific quirks local.

### `src/channels/`

- Keep platform-specific parsing, mentions, attachment handling, send/edit semantics, and typing indicators local to the adapter.
- Do not leak Discord or Telegram details into runtime rules unless they become an explicit shared concept.

### `src/agents/`

- Runner modules should focus on process lifecycle, environment prep, and output protocol.
- Provider routing, paired-role policy, and platform delivery rules should stay outside the runner layer.

### `src/shared/`

- Only put code here when it is truly cross-cutting and stable.
- Prefer specific modules over generic `utils` growth.
- Shared types should reflect domain language used across subsystem boundaries.

## Touched-Code Policy

- New code must follow this standard.
- Edited legacy code should be improved opportunistically when the change already touches that area.
- Do not require a full rewrite before accepting a useful fix.
- Do block changes that make hotspot files, functions, or boundaries harder to understand.

## Code Review Checklist

Use this in PRs, reviews, and agent prompts:

- Is the file’s responsibility obvious?
- Is the main control flow easy to scan top-to-bottom?
- Are domain names explicit and consistent with GoodKiddo concepts?
- Are side effects pushed to the edges where possible?
- Would a new helper or module make this easier to understand?
- Is any subsystem boundary being crossed in a surprising way?
- Does this change make a known hotspot easier to maintain, or at least not worse?
- If the file or function is large, is the reason documented and convincing?

## Applying The Standard To Current Hotspots

### `src/runtime/message-runtime.ts`

- Split inline rule logic into focused helpers when the reader has to context-switch between queueing, prompt building, handoff handling, and delivery behavior.
- Keep the top-level runtime flow as orchestration code.
- Move behavior comments toward invariants and turn lifecycle decisions.

### `src/persistence/db.ts`

- Split by capability when a change only touches one domain such as messages, sessions, tasks, room modes, or paired workflows.
- Keep migration and schema code discoverable without forcing readers through every query helper.
- Prefer domain-focused exports over one giant persistence surface.

### `src/channels/discord.ts`

- Keep Discord-specific semantics in the adapter, but extract reusable decision helpers for transcription, typing lifecycle, and message normalization.
- Avoid burying unrelated send, receive, and attachment flows in the same long method.

## Adoption

- Treat this document as the source of truth.
- Keep shorter summaries in `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, and local folder READMEs.
- If those summaries drift from this file, update them to match this document.
