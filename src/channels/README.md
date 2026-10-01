# Channels

This folder owns platform adapters. A channel adapter converts platform-native events into GoodKiddo's internal message flow and sends responses back out.

## Main Files

- `discord.ts` - Discord adapter
- `telegram.ts` - Telegram adapter via long polling
- `registry.ts` - channel registration and lookup
- `index.ts` - channel bootstrap wiring

## Start Here

1. `registry.ts`
2. `discord.ts` or `telegram.ts`

## Boundaries

- Keep mention parsing, attachment handling, and platform-specific semantics here
- Keep provider logic out of this folder
- Keep core message-loop logic in `../runtime/`

## Maintainability Notes

- Keep platform semantics local to the adapter instead of leaking them into shared runtime logic.
- Extract focused helpers when one adapter starts mixing receive flow, send flow, typing lifecycle, and attachment processing in the same large block.
- Follow the review triggers in [`MAINTAINABILITY.md`](../../MAINTAINABILITY.md) for large files and mixed responsibilities.
