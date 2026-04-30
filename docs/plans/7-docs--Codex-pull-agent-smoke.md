# Plan: Codex pull-agent smoke doc

## Overview
Add a tiny documentation-only smoke artifact proving the GoodKiddo pull-agent can run ralphex with Codex as coder and reviewer.

## Constraints
- Documentation-only change.
- Do not modify runtime code, package files, lockfiles, or CI config.
- Keep the change small and easy to review.

## Validation Commands
- `bun --version`

### Task 1: Add smoke documentation
- [x] Create `docs/features/codex-pull-agent-smoke.md`.
- [x] Document that this file was created by the pull-agent smoke test.
- [x] Include the agent goal: Codex coding at medium effort and review at high effort.
- [x] Keep the document under 40 lines.
