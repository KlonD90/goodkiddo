# Channels

Channel runtime adapters for the CLI and Telegram entrypoints.

- `index.ts` — channel registry and dispatch by `APP_ENTRYPOINT`
- `cli.ts` — interactive local channel
- `telegram.ts` — multi-tenant Telegram channel
- `shared.ts` — shared agent-session helpers
- `session_commands.ts` — channel-agnostic session commands (`/new-thread` summarizes and rotates the thread)

## Telegram Formatting

Telegram replies are rendered from normal LLM Markdown, but they are sent to Telegram as `HTML`.

Why:

- Telegram does not support general CommonMark/GFM directly.
- Telegram `MarkdownV2` is brittle and requires aggressive escaping.
- `HTML` is the more reliable transport format for mixed prose, lists, code, and links.

Current pipeline:

1. The model produces normal Markdown-ish text.
2. The Telegram channel parses it with `markdown-it`.
3. Output is normalized to Telegram-safe HTML only.
4. Unsupported structures are rewritten into Telegram-friendly text.
5. The final rendered payload is chunked to stay under Telegram's message limit.

Supported formatting:

- headings
- bold / italic / strikethrough
- inline code
- fenced code blocks
- links
- ordered and unordered lists
- blockquotes
- Markdown tables, rewritten into readable Telegram sections

Rules:

- do not send raw model HTML through to Telegram
- do not rely on unsupported Telegram tags like `<table>` or `<br>`
- chunk by rendered Telegram payload, not just source Markdown length

## Telegram Tables

Telegram does not support HTML tables, so Markdown tables are converted before sending.

Behavior:

- 2-column tables render as `Label: Value`
- comparison tables render as a bold row title plus per-column bullet lines
- inline Markdown inside headers and cells is preserved
- multiline cell content is normalized into readable Telegram text

Large tables:

- oversized tables are split before sending
- row-based splits repeat the table header context
- wide single-row comparison tables are split without losing the row label or column headers

## Telegram Streaming

Telegram responses stream progressively instead of waiting for one final message.

Behavior:

- the bot sends `typing...` while the agent is working
- partial output is flushed in readable chunks
- incomplete Markdown structures are buffered instead of being sent half-open
- the final stream flush sends the full remaining buffer so table-aware chunking can run on the complete content

The stream chunker tracks:

- fenced code blocks
- inline code spans
- paired emphasis delimiters like `**`, `__`, `~~`
- trailing Markdown table context, including header and separator rows

This avoids broken continuation chunks where later table rows appear without their headers.

## Telegram How-To

Relevant files:

- `src/channels/telegram.ts`
- `src/channels/telegram.test.ts`

Recommended workflow:

1. Update rendering or chunking logic in `src/channels/telegram.ts`
2. Add or update regression tests in `src/channels/telegram.test.ts`
3. Run:

```bash
bun test src/channels/telegram.test.ts
bunx biome check src/channels/telegram.ts src/channels/telegram.test.ts
```

4. Restart the bot process after changes

When editing this path:

- treat stream chunking and final message chunking as separate problems
- preserve table header context when splitting
- prefer readable Telegram output over literal Markdown fidelity

## Telegram troubleshooting

When Telegram behavior looks "stuck", separate the failure into one of these buckets before changing the permission model.

### 1. Stale command menu

Symptom: Telegram shows commands that the bot no longer supports, or tapping a menu command appears to do nothing.

What to check:
- The bot must call `setMyCommands` on startup.
- Telegram command names must use only lowercase letters, digits, and underscores.
- A single invalid command makes the whole `setMyCommands` call fail.

Known pitfall:
- `/new-thread` is invalid for Telegram Bot API command registration.
- Register `/new_thread` instead. The handler may still accept `/new-thread` from raw text, but the menu must use `/new_thread`.

### 2. Unknown slash command falls through silently

Symptom: user taps a slash command and gets no visible response.

What to check:
- Normalize Telegram commands like `/policy@BotUsername` before matching.
- If a slash command is unknown, reply explicitly instead of letting it fall through to the agent.

### 3. Approval buttons do nothing

Symptom: approval prompt is shown, but tapping `Approve` or `Deny` has no effect.

What to check:
- Telegram callback payloads may contain more than one `:`.
- Parse callback data by splitting on the first `:` only.

Known pitfall:
- Payloads like `approve-once:1712345678901:abc123` will break if parsed with `split(":", 2)`, because the prompt id gets truncated and no pending approval matches it.

### 4. Turn stalls when several approvals are pending

Symptom: the bot asks to approve two reads or tool calls, and the turn hangs after one or both prompts appear.

What to check:
- Do not store Telegram approvals in a single `pending` slot.
- Track them by `promptId`, for example with `Map<string, PendingApproval>`.
- Resolve button clicks by exact `promptId`.

Known pitfall:
- If the second approval prompt overwrites the first pending state, one approval promise is left unresolved and the whole agent turn blocks.

### 5. Plain-text approval is ambiguous

Symptom: user types `approve` or `deny` while multiple approval prompts are visible.

What to check:
- Free-text approval should only work when exactly one approval is pending.
- If several are pending, tell the user to use the buttons on the specific prompt.

Do not:
- Guess which approval `approve` refers to.

### 6. Memory looks stale after a successful write

Symptom: tool approval succeeds and `memory_write` runs, but the next turn still answers from old memory.

What to check:
- If memory is baked into the system prompt at agent construction time, refresh the agent between turns so the next turn sees current memory.
- Keep the same thread/checkpoint state while rebuilding the prompt.

### 7. Basic debugging checklist

When Telegram is misbehaving, verify these in order:
- Bot startup completed without `GrammyError` from `setMyCommands`.
- The running process is the latest build, and old bot processes are not still polling.
- Slash commands are normalized for `@BotUsername` suffixes.
- Unknown slash commands return a visible reply.
- Callback payload parsing preserves the full `promptId`.
- Multiple pending approvals are stored independently, not in one field.
- Text approval is rejected when several prompts are pending.

### 8. Formatting and chunking regressions

Symptom: Telegram shows raw `**bold**`, raw table pipes, broken continuation chunks, or `message is too long`.

What to check:

- `renderTelegramHtml()` for Markdown-to-Telegram rendering
- `chunkRenderedTelegramMessages()` for Telegram-length splitting after rendering
- `takeTelegramStreamChunks()` for streaming-time buffering and structure tracking

Common failures:

- `can't parse entities: Unsupported start tag "table"`
  Cause: unsupported HTML reached Telegram
- `message is too long`
  Cause: rendered output exceeded Telegram's 4096-character limit
- raw `**bold**`, raw pipes, or broken table continuation chunks
  Cause: content was split before the formatter had enough context
