# Plan: Prepared Follow-ups — Draft Artifact Generator v1

## Goal
Generate safe internal artifacts GoodKiddo can prepare before nudging: client follow-up drafts, proposal outlines, checklists, decision memos, and message/email drafts. It must never send/publish/submit externally.

## Product doctrine reminder
GoodKiddo is a Telegram-native safe-by-construction assistant for non-technical solo entrepreneurs. Harmless safe-space actions may happen directly. Outside-world final effects are not capabilities: no sending, publishing, paying, submitting irreversible forms, deleting/canceling external state, inviting others, or deciding on behalf of the user.

Prepared Follow-ups quality bar: before interrupting, GoodKiddo must do useful work: recall context, check available evidence, prepare a draft/checklist/recommendation, or ask one specific missing detail.

## Dependency / queueing
- Mostly independent. Can use existing memory/files/tooling.
- Good candidate for `gode` after current three agents finish if Nick wants a low-risk product-visible slice.

## Existing areas to inspect
- virtual filesystem / file tools under `bot/src/tools/`
- memory tools under `bot/src/tools/memory_tools.ts`
- research notes/artifact patterns under `bot/src/capabilities/research/`
- channel attachment/file-send behavior if artifacts are delivered back to user

## Scope
In:
- Internal draft artifacts only.
- Artifact types: follow-up message, proposal outline, checklist, decision memo, content/social draft.
- Store or return draft in GoodKiddo safe-space.
- Include clear “draft only — user sends/uses manually” framing where relevant.

Out:
- No sending email/messages.
- No publishing posts.
- No form submission.
- No approval/permission prompts for internal draft creation.

## Validation Commands
- `bun test bot/src/tools/filesystem_tools.test.ts bot/src/tools/memory_tools.test.ts bot/src/capabilities/research/notes.test.ts`
- `bun run typecheck`
- `bun run check`

### Task 1: Decide artifact model
- [x] Reuse existing virtual file/artifact patterns if available.
- [x] Define title/type/body/source_context metadata.
- [x] Keep artifacts private/internal.

### Task 2: Add generator helper/tool
- [x] Generate a draft artifact from task/context/evidence input.
- [x] Support the v1 artifact types with clear templates.
- [x] Return path/id and preview.

### Task 3: Tests
- [x] Test each artifact type template.
- [x] Test drafts are internal and not sent externally.
- [x] Test source context is preserved.

### Task 4: Docs
- [ ] Document artifact types and safe boundary.

## Acceptance Criteria
- GoodKiddo can prepare and store useful draft artifacts.
- It is impossible for this feature to send/publish/submit externally.
- Tests cover artifact generation and safe boundary wording.
