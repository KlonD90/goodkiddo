# Good Vibes: Send Handle

Send Handle is a lightweight GoodKiddo prompt/orchestration feature for messy customer-facing drafts, checklists, missing questions, or next steps.

## What it does

On eligible artifact-producing turns, GoodKiddo may add **at most one** tiny practical handhold that helps the human use the artifact. The handle belongs to the user: something they can send, check, trim, or reuse.

Good examples:

- "Before sending: confirm the ETA and replace `[delivery window]`."
- "Use this if they push back: ‘I can do today or tomorrow — which works better?’"
- "To stay warm without overpromising: keep the first sentence, then add the ETA."
- "If you want shorter: send only the first two sentences."

This is not a bot victory lap. The feature must not congratulate GoodKiddo for producing an answer.

## Guardrails

Send Handle stays off for sensitive or high-stakes flows, using the current text plus recent context:

- grief, death, illness, accident
- anger, complaints, harassment, disputes, or escalation
- billing, refunds, invoices, chargebacks, cancellations, or payments
- security/privacy/account-access issues
- legal, medical, self-harm, safety, emergencies, or urgent incidents/outages
- low-signal turns and commands

Runtime prompt constraints:

- zero or one handle, only if useful and artifact-adjacent
- under 18 words
- user-owned: a phrase, check, edit, or choice the human can use
- no self-praise or self-congratulation
- never: "Tiny win: the mess/thread is now...", "we cleaned...", "the thread is solved", "GoodKiddo solved..."
- avoid surveillance/AI/corporate phrasing like "I noticed" or "as an AI"
- zero or one emoji max

## Production signal

Eligible candidate turns emit PostHog event `send_handle_candidate` when analytics is configured. Properties contain only derived metadata:

- `trigger`: `messy_to_artifact` or `artifact_followup`
- `channel`: `cli` or `telegram`

No raw message text is sent.

## Evals and tests

```bash
PATH="/home/klonclaw/.bun/bin:$PATH" bun test bot/src/vibes/send_handle.test.ts
PATH="/home/klonclaw/.bun/bin:$PATH" bun run --filter goodkiddo-bot eval:send-handle
```

`eval:send-handle` always runs offline deterministic fixture/rubric checks. To add an optional LLM judge pass, configure `AI_TYPE`, `AI_MODEL_NAME`, `AI_API_KEY` and run with `SEND_HANDLE_LLM_JUDGE=1`.
