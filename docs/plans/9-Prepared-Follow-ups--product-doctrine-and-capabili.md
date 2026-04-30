# Plan: Prepared Follow-ups Product Doctrine and Capability Boundary

## Goal
Document GoodKiddo's safe-by-construction product doctrine so future proactive features and integrations share the same boundary: GoodKiddo may act directly inside its safe space, but outside-world final effects are not capabilities.

## Product context
GoodKiddo is a Telegram-native assistant for non-technical solo entrepreneurs. It is not Hermes-for-power-users. Proactive behavior should be useful because GoodKiddo prepared something, not because it nags.

Core doctrine:
- Safe-space actions can be done directly: memory, tasks, timers, drafts, virtual files, browser research, private internal organization.
- Outside-world final effects are impossible by design: no sending email, publishing, paying, ordering, deleting/canceling external state, inviting other people, submitting irreversible forms, or approving/rejecting on behalf of the user.
- No permission theater: do not add approval prompts for harmless internal actions; design dangerous external actions out of the capability surface.
- Human remains final decider for outside-world actions.
- No dumb nudges: proactive messages must include checked context, evidence, a draft/artifact, a recommendation, or one specific missing detail.
- Recall before asking: search memory/log/checkpoints/tasks/files before asking user to repeat ambiguous prior context.

## Scope
Implement documentation/spec only. No runtime behavior change required in this issue.

## Suggested files
- `docs/features/feature-prepared-followups-roadmap.md`
- `docs/features/README.md`
- If there is a better existing product/architecture doc location, use it, but keep the roadmap discoverable from `docs/features/README.md`.

## Validation Commands
- `bun run check`
- `bun run typecheck`

### Task 1: Add feature roadmap/spec doc
- [x] Create a Prepared Follow-ups roadmap/spec doc.
- [x] Include the safe-space vs outside-world boundary.
- [x] Include the human-final-decider rule.
- [x] Include the prepared-follow-up quality bar: “Did GoodKiddo do useful work before interrupting?”
- [x] Include the recall-before-asking rule.
- [x] Include independent feature slices for implementation follow-up issues.

### Task 2: Link from feature docs index
- [ ] Add the roadmap/spec to the active feature list in `docs/features/README.md`.
- [ ] Keep the table/list formatting consistent with the file.

### Task 3: Check docs consistency
- [ ] Ensure wording does not frame GoodKiddo as a permission-gated powerful agent.
- [ ] Ensure it says outside-world final effects are unavailable by capability design.
- [ ] Ensure it is clear this feature direction is for solo entrepreneurs and Telegram-native use.

## Acceptance Criteria
- Roadmap/spec is committed and discoverable from `docs/features/README.md`.
- The doctrine explicitly rejects generic nagging and permission-theater framing.
- No code behavior changes are included.
