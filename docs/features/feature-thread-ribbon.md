# Good Vibes: Thread Ribbon

Thread Ribbon is a tiny GoodKiddo conversational flourish for customer-facing support/business threads.

## What it does

When a messy or uncertain thread becomes a concrete artifact — a reply draft, checklist, missing question, or next step — the bot may end with one short bespoke line naming the relief/progress. The goal is: *the scary blob is now a next move*.

Example energy:

- "Tiny win: the thread is one reply and one question now."
- "That has a shape now: clear, kind, and yours to send."

It is prompt/orchestration-only: a deterministic classifier adds one-turn runtime context; the model decides whether a ribbon is actually helpful after producing the artifact.

## Guardrails

Thread Ribbon stays off for sensitive or high-stakes flows:

- grief, death, illness, accident
- anger, abuse, complaints, urgent escalations/outages
- refunds, billing, payments, disputes, cancellations
- security incidents, hacked accounts, passwords, breaches
- legal, medical, safety, self-harm
- commands, empty text, multimodal-only turns

Runtime prompt constraints:

- zero or one ribbon, only at the end
- <=18 words
- specific to the progress/artifact, not generic praise
- no "I noticed", "as an AI", corporate tone, forced cheer, or emoji spam
- keep the human in control; GoodKiddo drafts, the user decides/sends

## Production signal

Eligible candidate turns emit PostHog event `thread_ribbon_candidate` when analytics is configured. Properties contain only derived metadata:

- `trigger`: `messy_to_artifact` or `finish_after_artifact`
- `channel`: `cli` or `telegram`

No message text is sent to analytics.

## Evals and tests

Run:

```bash
PATH="$HOME/.bun/bin:$PATH" bun run --filter goodkiddo-bot test
PATH="$HOME/.bun/bin:$PATH" bun run --filter goodkiddo-bot eval:thread-ribbon
```

`eval:thread-ribbon` always runs offline deterministic fixture/rubric checks. To add an optional LLM judge pass, configure `AI_TYPE`, `AI_MODEL_NAME`, `AI_API_KEY` and run with `THREAD_RIBBON_LLM_JUDGE=1`.
