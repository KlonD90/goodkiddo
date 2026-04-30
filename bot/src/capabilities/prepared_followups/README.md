# prepared_followups

Prepared follow-up helpers create private draft artifacts before GoodKiddo nudges a user. They are safe-space preparation only: the tool writes markdown into the virtual filesystem and returns an internal path plus a preview.

## Artifact types

The v1 artifact types are:

- `follow_up_message` — a message or email-style follow-up draft the user can edit and send manually.
- `proposal_outline` — a proposal structure with context, evidence, sections, assumptions, and the user's manual next step.
- `checklist` — a verification checklist for a pending manual action.
- `decision_memo` — a short decision note with evidence, options, a recommendation draft, and open questions.
- `content_social_draft` — a post or content draft with supporting points and pre-use checks.

Each artifact stores:

- `title`
- `type`
- `body`
- `source_context`, including the task, context summary, evidence, source paths, and source URLs when supplied

Artifacts are stored under `/prepared-followups/*.md` with `visibility: "internal"` metadata.

## Safe boundary

Prepared follow-up artifacts must remain internal GoodKiddo state. Creating one must not send messages, send email, publish posts, submit forms, share files, pay, order, invite people, delete or cancel external state, or otherwise cause an outside-world final effect.

Every generated artifact includes the draft-only notice:

```text
Draft only - user sends/uses manually. Internal GoodKiddo artifact; not sent, published, submitted, or shared externally.
```

The `prepare_draft_artifact` tool returns only the stored artifact id, path, type, title, internal visibility, safe-boundary notice, and preview. The user remains responsible for any later external use.
