# Channels

Channel runtime adapters for the CLI and Telegram entrypoints.

- `index.ts` — channel registry and dispatch by `APP_ENTRYPOINT`
- `cli.ts` — interactive local channel
- `telegram.ts` — multi-tenant Telegram channel
- `shared.ts` — shared agent-session helpers, including the persistent checkpointer wiring
- `session_commands.ts` — channel-agnostic session commands (`/new_thread` summarizes and rotates the thread and surfaces task state)

## Shared Session State

CLI and Telegram sessions share the same LangGraph checkpoint flow:

- live thread state is persisted in the database selected by `DATABASE_URL`
- the active thread id per caller is persisted in `active_threads`, so `/new_thread` and compaction-triggered rotations survive restarts
- checkpoints are handled by the SQL-backed saver in [`src/checkpoints/sql_saver.ts`](../checkpoints/sql_saver.ts)
- forced checkpoint summaries are stored separately in [`src/checkpoints/forced_checkpoint_store.ts`](../checkpoints/forced_checkpoint_store.ts)
- `pendingTaskCheck` marks the next substantive turn after session start or `/new_thread` so boundary-only task reconciliation runs once
- the checkpointer, permission store, workspace backend, and web access store share one injected `Bun.SQL` connection created in [`src/bin/bot.ts`](../bin/bot.ts)
- rebuilding the agent between turns refreshes the system prompt without losing thread history

This is separate from the `/memory/` wiki. The wiki stores durable notes and preferences; the checkpointer stores the current turn-by-turn conversation state; the SQL task store holds open and recently closed actionable work.

## Compacted context loading

After a forced checkpoint is created, channel sessions load compacted runtime context instead of replaying full stored history.

`full_history != runtime_context`. Full turn history stays in the SQL saver for audit and recovery. The model sees only:

1. Latest forced checkpoint summary (serialized as a runtime-only prompt block)
2. Last 2 user-initiated turns (including interleaved assistant/tool messages within each turn)
3. Current user input

Forced checkpoints are created at defined boundaries — `/new_thread`, session resume, and prompt-budget pressure — by [`src/checkpoints/compaction_trigger.ts`](../checkpoints/compaction_trigger.ts). That trigger layer decides which boundary fired, calls [`src/memory/checkpoint_compaction.ts`](../memory/checkpoint_compaction.ts) to build the structured summary, persists it through `ForcedCheckpointStore`, and uses [`src/memory/runtime_context.ts`](../memory/runtime_context.ts) to render the runtime-only prompt context.

The checkpoint summary and retained turns are injected through the rebuilt system prompt for the next turn only. They are not re-persisted as ordinary chat messages in the new thread, so the stored thread history remains the raw exchange record.

`/new_thread` continues to rotate the thread id and summarize to `log.md`, and also now triggers a forced checkpoint so the next session begins from a compact baseline rather than a cold start. The immediate `/new_thread` reply includes the previous-thread summary, the caller's current active tasks, and recently completed tasks from the last 7 days.

The same boundary flow also runs task reconciliation once per session boundary. On the first substantive turn after session start or `/new_thread`, active SQL tasks are compared against the current user message. Exact single-task completion matches may be auto-completed; ambiguous matches are left unchanged; likely dismissals are converted into explicit confirmation prompts instead of automatic state changes.

If a thread was rotated for compaction but the first seeded turn has not been written yet, session startup recovers the latest checkpoint and seeds the empty active thread before continuing. This keeps compaction continuity intact across crashes and restarts.

When an attachment only fits after compaction, Telegram can emit an ephemeral status line before the forced checkpoint runs so the user sees why older context is being summarized. That notice uses the same status-emitter path as tool activity, so it never enters stored history or runtime context.

When no checkpoint exists for a thread, the channel falls back to replaying full history unchanged. The `RuntimeContext.hasCompaction` flag distinguishes these two paths.

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
5. The same renderer is used for text replies and attachment captions.
6. The final rendered payload is chunked to stay under Telegram's message limit.

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
- do not pass raw attachment captions straight into Telegram `parse_mode: HTML`
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
- short completed paragraphs can flush on a timer once they end with a blank-line paragraph break and the paragraph looks complete
- if the buffered reply would exceed Telegram's limit before that, it is split early on safe whitespace boundaries with markdown structures kept closed
- incomplete Markdown structures are buffered instead of being sent half-open
- the final stream flush sends the full remaining buffer so table-aware chunking can run on the complete content

The stream chunker tracks:

- fenced code blocks
- inline code spans
- paired emphasis delimiters like `**`, `__`, `~~`
- trailing Markdown table context, including header and separator rows
- overlapping or cumulative streamed text snapshots so partial output is not duplicated

This avoids broken continuation chunks where later table rows appear without their headers.

## Telegram How-To

Relevant files:

- `src/channels/telegram.ts`
- `src/channels/telegram.test.ts`

Photo handling:

- Telegram `message:photo` updates are accepted
- captions are treated as user text
- the largest Telegram photo variant is downloaded and sent to the model as an image content block
- if the streamed response yields no visible text, Telegram falls back to the latest assistant text in final agent state instead of a generic placeholder or trailing user text

Voice handling:

- Telegram `message:voice` updates are accepted
- voice messages are enabled by default and can be disabled with `ENABLE_VOICE_MESSAGES=false`
- supported voice payloads are capped at `1_048_576` bytes and are downloaded as `audio/ogg`
- the channel transcribes voice audio in memory, prefixes it as `_Transcribed: ..._`, and appends any caption text after the transcript
- approvals and slash/session commands are parsed from the raw transcript before the prefixed agent-facing text is queued
- transcription uses the configured backend selected by `TRANSCRIPTION_PROVIDER=openai|openrouter`
- `openai` uses the Audio Transcriptions API; `openrouter` uses OpenRouter's documented `/chat/completions` audio-input flow with the default `openai/whisper-1` model
- set `TRANSCRIPTION_API_KEY` when voice transcription cannot reuse `AI_API_KEY`, and use `TRANSCRIPTION_BASE_URL` to override the provider endpoint used for transcription
- disabled voice support replies with `Voice messages are not supported on this server.`
- oversized audio replies with `Voice message is too large`
- download failures reply with `Failed to download voice message: <message>`
- transcription failures reply with `Transcription failed: <message>`

Relevant voice files:

- `src/channels/telegram.ts`
- `src/channels/telegram.test.ts`
- `src/capabilities/voice/README.md`

PDF handling:

- Telegram `message:document` updates are accepted when `mime_type === "application/pdf"`
- PDF documents are enabled by default and can be disabled with `ENABLE_PDF_DOCUMENTS=false`
- PDFs are capped at 20 MB (hard limit defined in `PDF_MAX_BYTES`)
- the channel downloads the file, extracts text per page, and injects it as `_Document: <filename> — N pages_` prefixed content
- encrypted/password-protected PDFs reply with `This PDF is password-protected and cannot be read.`
- corrupt or invalid PDFs reply with `Failed to read PDF: <reason>`
- empty PDFs (no extractable text) reply with `This PDF appears to contain no text.`
- oversized PDFs reply with `PDF is too large (max 20 MB).`
- non-PDF documents are silently ignored (no error reply)

Relevant PDF files:

- `src/channels/telegram.ts`
- `src/channels/telegram.test.ts`
- `src/capabilities/pdf/README.md`

Spreadsheet handling:

- Telegram `message:document` updates are accepted for CSV and Excel files (.csv, .xlsx, .xls)
- supported MIME types: `text/csv`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- spreadsheets are enabled by default and can be disabled with `ENABLE_SPREADSHEETS=false`
- spreadsheets are capped at 10 MB (hard limit defined in `SPREADSHEET_MAX_BYTES`)
- the channel downloads the file, parses all sheets, and injects it as `_Spreadsheet: <filename> — N rows, M columns_` prefixed content with markdown tables
- CSV files render as a single markdown table (sheet name header omitted)
- Excel files render all sheets with sheet name headers as separators
- corrupt or invalid files reply with `Failed to read spreadsheet: <reason>`
- empty spreadsheets (no data rows) reply with `This spreadsheet appears to be empty.`
- oversized spreadsheets reply with `Spreadsheet is too large (max 10 MB).`
- non-spreadsheet documents are silently ignored (no error reply)

Relevant spreadsheet files:

- `src/channels/telegram.ts`
- `src/channels/telegram.test.ts`
- `src/capabilities/spreadsheet/README.md`

## Tool Activity Status

Status messages surface short, human-readable lines to the active channel whenever the agent invokes a tool (e.g. "Reading a.txt", "Searching for X", "Running workspace entrypoint"). Users see what is happening between turn start and the final reply.

### sendStatus Interface

```typescript
interface OutboundChannel {
  sendStatus(callerId: string, message: string): Promise<void>;
  // ... other methods
}
```

- `callerId` — session identifier (e.g. `cli:username` or Telegram chat ID)
- `message` — localized, pre-truncated status string
- **Ephemeral** — status messages are never stored in conversation history and never replayed into runtime context
- **Must never throw** — emitter failures are caught internally and ignored

### CLI Status Output

The CLI channel writes status lines to stdout with a `>` prefix:

```
> Reading a.txt
> Searching for X
```

### Telegram Status Output

The Telegram channel sends status messages as plain text via `bot.api.sendMessage`, without touching conversation memory.

### Configuration

- `enableToolStatus` (default `true`) — enables or disables status emission globally
- `enableAttachmentCompactionNotice` (default `true`) — emits the ephemeral "making room for this attachment" notice before attachment-triggered compaction
- `defaultStatusLocale` (default `"en"`) — fallback locale when user preference is unknown

### Relevant Files

- `src/channels/outbound.ts` — OutboundChannel interface with sendStatus
- `src/channels/cli.ts` — CLI implementation of sendStatus
- `src/channels/telegram.ts` — Telegram implementation of sendStatus
- `src/tools/status_emitter.ts` — StatusEmitter factory and no-op emitter
- `src/tools/status_templates.ts` — per-tool, per-locale status templates
- `src/i18n/locale.ts` — locale resolution utilities

## Scheduled Timers

Timers let the agent run memory file prompts on cron schedules and deliver results to the user's Telegram chat.

User-facing timer operations are available via agent tools:

- `create_timer(mdFilePath, cronExpression, timezone?)` — set a recurring timer
- `list_timers()` — show all active timers
- `update_timer(timerId, updates)` — change cron, timezone, or enabled state
- `delete_timer(timerId)` — remove a timer

The scheduler runs in-process, polling every 60 seconds for due timers. When a timer fires, the scheduler reads the referenced memory file, executes it via the LLM, and streams the result to the user's Telegram chat.

Failure handling:

- On LLM error: error is logged, `last_error` is stored, `next_run_at` is still updated
- After 3 consecutive failures: warning message sent to user via Telegram
- If memory file is deleted: timer is hard-deleted and user is notified

Timers persist in the database and survive restarts. Each timer is user-scoped: `user_id` and `chat_id` are stored on creation, and all operations validate ownership.

Relevant timer files:

- `src/capabilities/timers/store.ts` — SQL-backed timer persistence
- `src/capabilities/timers/scheduler.ts` — in-process background scheduler
- `src/capabilities/timers/tools.ts` — LLM tool definitions
- `src/capabilities/timers/README.md` — full timer documentation

Cron format: `minute hour day-of-month month day-of-week`. Examples:

- `0 10 * * 1-5` = every weekday at 10 AM
- `*/15 * * * *` = every 15 minutes
- `0 9 * * *` = every day at 9 AM

## Recommended workflow:

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
- keep voice downloads in memory only and route new transcription logic through `src/capabilities/voice/`

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
