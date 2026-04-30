# Feature: Prepared Follow-ups Roadmap

## Summary
Prepared Follow-ups define how GoodKiddo can proactively help Telegram-native solo entrepreneurs by preparing useful work inside its own safe space. GoodKiddo returns with context, evidence, and a concrete next step for the user to decide. It does not create final effects in external systems, and those effects are not hidden behind approval prompts.

## Product doctrine
GoodKiddo is useful when it does preparatory work before interrupting. The test for any proactive message is: did GoodKiddo do useful work before interrupting?

Prepared follow-ups should include at least one of:
- Checked context from memory, tasks, files, browser research, or recent conversation.
- Evidence or source notes that explain why the follow-up matters now.
- A draft, checklist, comparison, summary, or other artifact the user can act on.
- A recommendation with the reasoning already worked through.
- One specific missing detail needed to continue.

Prepared follow-ups should not be generic nagging. "Just checking in" messages are out of scope unless GoodKiddo has prepared something concrete or found a specific blocker.

## Capability boundary
Safe-space actions can happen directly because they only affect GoodKiddo-controlled state:
- Memory and notes.
- Tasks and timers.
- Drafts and virtual files.
- Browser research and private synthesis.
- Internal organization, triage, and preparation.

Outside-world final effects are unavailable by capability design. GoodKiddo must not send email, publish content, pay, order, delete or cancel external state, invite other people, submit irreversible forms, or approve or reject anything on the user's behalf.

This is not a permission-theater model. Dangerous external final actions are not part of the capability surface, so approval prompts are not used to unlock them. The human remains the final decider for anything that leaves GoodKiddo's safe space.

## Recall before asking
Before asking the user to repeat ambiguous prior context, GoodKiddo should first search the places where it may already know the answer:
- Long-term memory and notes.
- Active tasks and timers.
- Recent checkpoints and conversation summaries.
- Virtual files and drafts in the workspace.
- Prior browser research notes when available.

If recall finds a likely answer, GoodKiddo should proceed with that context or ask a focused confirmation question. If recall does not find enough context, the assistant should ask for the smallest missing detail.

## User cases
- A solo entrepreneur asks GoodKiddo to keep an eye on a supplier's pricing page. GoodKiddo later returns with the checked change, a source link, and a suggested reply draft, but the user sends the message themselves.
- A user leaves a half-finished launch announcement in a virtual file. GoodKiddo later prepares a cleaned-up draft and asks for the one missing date before the user posts it.
- A user has several active sales tasks. GoodKiddo notices a promised follow-up is due, checks prior notes, drafts a Telegram-ready reply, and lets the user decide whether to send it.
- A user asks for help comparing vendors. GoodKiddo researches and prepares a recommendation, but it cannot order, pay, sign, approve, or invite anyone.

## Scope
**In:**
- Product doctrine for prepared follow-ups.
- Safe-space actions that GoodKiddo may perform directly.
- Outside-world final effects that GoodKiddo cannot perform by design.
- Human-final-decider rule for anything outside GoodKiddo-controlled state.
- Prepared-follow-up quality bar and recall-before-asking rule.
- Independent implementation slices for future execution plans.

**Out:**
- Runtime behavior changes in this documentation pass.
- New approval prompts for external actions.
- External connectors that can create final effects.
- Multi-user workflows, team approvals, or delegated authority.

## Roadmap slices
Each slice should be independently shippable and should preserve the capability boundary above.

1. Prepared follow-up doctrine prompt
   - Add the safe-space and outside-world boundary to the agent instructions.
   - Teach the model to reject permission-theater framing.
   - Require the human-final-decider rule for external effects.

2. Recall-before-asking retrieval pass
   - Before asking for prior context, search memory, tasks, timers, checkpoints, and virtual files.
   - Prefer a focused confirmation question over asking the user to restate broad context.
   - Add tests for ambiguous follow-up requests that should use existing context.

3. Prepared artifact quality gate
   - Define when a proactive message is allowed to interrupt.
   - Require checked context, evidence, a draft, a recommendation, or one specific missing detail.
   - Add tests that reject generic nagging without prepared work.

4. Safe-space follow-up actions
   - Allow direct internal preparation such as drafting, task updates, timers, file organization, and research notes.
   - Keep all effects inside GoodKiddo-controlled state.
   - Add audit-friendly summaries so users can see what was prepared.

5. Outside-world refusal and handoff patterns
   - Make unsupported final effects explicit in tool and prompt behavior.
   - Provide handoff artifacts the user can copy, send, approve, buy, publish, or submit themselves.
   - Add tests for email, payment, ordering, publishing, deletion, cancellation, invitation, and approval requests.

6. Telegram-native follow-up presentation
   - Format follow-ups for compact Telegram reading.
   - Include the prepared artifact first, followed by the decision or missing detail needed from the user.
   - Avoid long status narration unless it carries evidence or a useful artifact.

## Design notes
- Prepared Follow-ups are aimed at non-technical solo entrepreneurs. The feature should feel like a private operator preparing next steps, not a general automation platform.
- Telegram is the primary surface. Follow-ups should be concise, readable in chat, and action-oriented.
- Internal actions do not need approval prompts when they are harmless and reversible inside GoodKiddo's safe space.
- External irreversible actions should not be modeled as "ask first, then do it." They should be modeled as unavailable, with GoodKiddo preparing the best possible handoff for the user.
- Future execution plans should keep slices small enough to validate with prompt/tool tests plus any affected integration tests.

## Related
- Execution plan: `docs/plans/9-Prepared-Follow-ups--product-doctrine-and-capabili.md`.
