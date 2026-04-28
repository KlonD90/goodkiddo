# Feature: Tool Activity Status Messages

## Summary
When the agent invokes a tool, emit a short, human-readable status message to the active channel so the user can see what the agent is doing between the moment a turn starts and the final reply arrives. Instead of a silent pause while the agent searches, reads a file, runs a command, or writes memory, the user sees lines like "Reading docs/features/README.md", "Searching for 'session'", or "Running workspace script". Status messages are informational only — they are not part of the conversation history the model reads back, and they are not durable memory.

## User cases
- A user on Telegram asks for a long task so that the bot surfaces "Reading X", "Writing Y" updates instead of appearing idle while tools run.
- A user on the CLI watches a multi-tool turn unfold so that each tool call is visible as a one-line status above the final reply.
- A user giving an ambiguous instruction sees the first couple of tool statuses so that they can interrupt early if the agent is going in the wrong direction.
- An operator debugging agent behavior can read the status stream in a live session to correlate tool calls with latency or errors without digging into logs.

## Scope
**In:**
- A per-tool status template layer that turns a tool invocation (name + selected args) into a short human sentence.
- Localized templates for at least English, Russian, and Spanish, with a documented path for adding more locales.
- A locale resolution rule that picks the user's language per-turn (see design notes) and falls back safely.
- A new `sendStatus(callerId, message)` method on the outbound channel abstraction, implemented for CLI and Telegram.
- A single hook in the tool wrapping layer that emits a status message when a tool starts executing.
- A config flag to enable the feature globally, a default locale setting, and safe defaults.
- Argument redaction rules so sensitive or oversized values (raw file contents, credentials, long strings) never reach the status line.
- Graceful no-op when a channel or tool has no template, and graceful fallback to the default locale when a translation is missing.

**Out:**
- Persisting status messages into stored conversation history or runtime context. Status lines are ephemeral.
- Editing or deleting prior status messages (no Telegram message-edit flow in v1).
- Intermediate progress updates from inside a long-running tool (only start, optionally completion in v1).
- User-configurable templates, filtering, or per-chat custom overrides (the locale is picked automatically; the template wording itself is not user-editable).
- Rich formatting: progress bars, spinners in Telegram, structured result previews.
- Status emission for sub-agents, nested pipelines, or background tasks outside the primary turn loop.
- Replacing existing logs or audit records — logs stay where they are.

## Design notes
- The natural hook is the tool wrapping layer at `src/tools/guard.ts` / `src/tools/factory.ts`. Every tool already passes through one wrapper before the agent receives it. Status emission should plug into the same wrapper so it applies uniformly.
- Channel plumbing: the wrapper needs a way to reach the active outbound channel. Today the outbound channel is constructed per-session in the channel entry points (`src/channels/cli.ts`, `src/channels/telegram.ts`) and passed to tools that need it (e.g. `send_file_tool`). The same pattern should extend to status emission — the wrapper receives a status emitter handle from session context rather than reaching for a global.
- Streaming differences between channels are real and must be respected:
  - CLI uses `agent.invoke(...)` (single synchronous result). Status lines go straight to `process.stdout` as soon as a tool starts.
  - Telegram uses `agent.stream(...)` with `streamMode: "messages"`. Status lines should be sent as separate short messages using `bot.api.sendMessage`, independent from the streamed reply text.
- The key invariant: **status messages are not replayed to the model**. They do not enter stored `full_history`, they are not part of `runtime_context`, and they are not considered assistant output for compaction purposes. This matches the existing `full_history != runtime_context` rule from the forced-checkpoints feature.
- Template contract: each tool owns a function `(args, locale) => string | null`. Returning `null` means "do not emit a status for this call". Central default handles tools that have no template. Templates are authored as a per-locale dictionary keyed by tool name plus an optional variant (e.g. `read_file.default`, `write_file.default`); the template function picks a string from the dictionary based on the resolved locale and interpolates whitelisted args.
- Locale resolution for a turn, in order: explicit per-session override if ever exposed → channel-provided hint (Telegram `user.language_code`; CLI process locale via `LANG` / `LC_ALL`) → `defaultStatusLocale` config value → hardcoded English fallback. Normalization strips region (e.g. `es-MX` → `es`). Unknown locales fall back to English.
- Supported locales at launch: English (`en`), Russian (`ru`), Spanish (`es`). The dictionary structure and fallback logic must make it cheap to add a new locale later without code changes outside the translation file.
- Translations should stay short, imperative, and match Telegram register. Keep placeholders identical across locales so arg substitution is uniform.
- Redaction: templates only receive a whitelisted subset of args. Raw file contents, credentials, long inputs, and full result payloads never flow into the status string. Paths, search patterns, short identifiers, and small enums are allowed.
- Error handling: a failure inside status emission must never break the tool call. The emitter catches and logs; tool execution proceeds.
- Completion status is optional and deferred. If the start-only signal is enough, we skip it. If needed, a second template variant can summarize the result (e.g. "Read 120 lines of a.md").
- Open questions, to settle during execution:
  - Should we deduplicate consecutive identical statuses inside a single turn, or let them repeat?
  - On Telegram, should multiple status messages be collapsed into one rolling message (via edit) to reduce notification noise? Out of scope for v1, but the data shape should not block it later.
  - Do we emit anything when a tool is rejected by permissions / guard before running? Leaning yes — the user should see the attempt.
- Tool inventory for template design: `filesystem_tools` (ls/read/write/edit/glob/grep), `browser_tools` (snapshot/action), `execute_tools` (workspace run), `memory_tools` (write/append/log/skill_write), `task_tools` (add/complete/dismiss/list), `send_file_tool`, `share_tools`. Each gets one template entry in the first pass.
