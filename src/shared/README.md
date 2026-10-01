# Shared

This folder owns stable cross-cutting types and small utilities that are used across subsystem boundaries.

## Typical Contents

- shared types used by multiple folders
- small utilities with clear, narrow purpose
- timezone and other low-level helpers that do not belong to a domain subsystem

## Boundaries

- `shared/` is not a fallback location for code with no obvious owner.
- Prefer specific domain folders when logic is mostly about channels, runtime, agents, persistence, or tasks.
- Keep helpers boring, explicit, and easy to test.
- Split generic utility growth into named modules before it turns into a dumping ground.

## Maintainability Notes

- Prefer domain language in shared types.
- Avoid hidden coupling by keeping helpers pure where possible.
- Follow the writing and review rules in [`MAINTAINABILITY.md`](../../MAINTAINABILITY.md).
