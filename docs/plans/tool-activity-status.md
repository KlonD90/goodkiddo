# Plan: Tool Activity Status Messages

## Overview
Surface short, human-readable status lines to the active channel whenever the agent invokes a tool ("Reading a.md", "Searching for X", "Running workspace script"), so users see what is happening between turn start and the final reply. Implementation plugs into the existing tool wrapping layer, extends the outbound channel with a new `sendStatus` method, and keeps status output fully ephemeral — not stored in conversation history and not replayed into runtime context.

## Validation Commands
- `bun tsc --noEmit`
- `bun test src/tools/status_templates.test.ts`
- `bun test src/i18n/locale.test.ts`
- `bun test src/tools/guard.test.ts`
- `bun test src/channels/outbound.test.ts`
- `bun test src/channels/cli.test.ts src/channels/telegram.test.ts`
- `bun test src/channels/shared.test.ts`

### Task 1: Define the status emitter contract
- [x] Add a `StatusEmitter` type describing a single method that accepts a caller/thread identifier and a short message string and returns a promise.
- [x] Add a no-op default emitter used when no channel supports status output, and make it easy to pass around in tests.
- [x] Document the contract in `src/tools/README.md` (or inline if no README) so it is clear status is ephemeral, non-replayed, and must never throw through to the tool caller.
- [x] Add unit tests for the default emitter and the wrap-vs-no-op fallback behavior.

### Task 2: Build locale resolution utilities
- [x] Create a small `src/i18n/locale.ts` module that defines the set of supported locales (`en`, `ru`, `es`) and a `resolveLocale(hint)` function that normalizes inputs (strips region, lowercases), falls back to `defaultStatusLocale` from config, then to `en`.
- [x] Add helpers that extract a locale hint from Telegram (`user.language_code`) and from the CLI environment (`LANG` / `LC_ALL`).
- [x] Ensure unknown or malformed locale strings never throw — they resolve to the default.
- [x] Add tests covering: exact match, region-stripped match (`es-MX` → `es`), unknown locale fallback, missing hint fallback, and config default override.

### Task 3: Build per-tool status templates with i18n
- [x] Create a `status_templates` module exposing a `renderStatus(toolName, args, locale)` function that returns a localized string or `null`.
- [x] Back it with a dictionary structured as `locale → toolName → template` so new locales are a single file addition. Ship `en`, `ru`, `es` at launch.
- [x] Cover all current tools: `filesystem_tools` (ls/read/write/edit/glob/grep), `browser_tools` (snapshot/action), `execute_tools` (workspace run), `memory_tools` (write/append/log/skill_write), `task_tools` (add/complete/dismiss/list), `send_file_tool`, `share_tools`.
- [x] Keep placeholder names identical across locales (e.g. `{path}`, `{pattern}`) so arg interpolation is uniform.
- [x] Enforce an argument allowlist per template — paths, short identifiers, search patterns, small enums only. Never include raw file contents, credentials, or long inputs.
- [x] Truncate interpolated values to a safe maximum length and strip newlines.
- [x] On missing translation for a tool in the resolved locale, fall back to English rather than returning `null`.
- [x] Add tests that cover: every tool template in every supported locale, English fallback when a locale is missing a key, redaction of oversized/forbidden args, and the "no template" fallback returning `null`.

### Task 3: Extend the outbound channel abstraction
- [x] Add `sendStatus(callerId: string, message: string): Promise<void>` to the `OutboundChannel` interface in `src/channels/outbound.ts`.
- [x] Implement `sendStatus` in the CLI outbound channel by writing a single prefixed line to stdout.
- [x] Implement `sendStatus` in the Telegram outbound channel by calling `bot.api.sendMessage` with plain text, without touching conversation memory.
- [x] Guarantee that emitter failures (network error, channel shutdown) are caught internally and never propagate.
- [x] Add tests per channel verifying output format, failure swallowing, and the callerId → destination mapping.

### Task 4: Hook status emission into the tool wrapping layer
- [x] Pass a `StatusEmitter` (derived from the active outbound channel) and a resolved locale into the tool factory/guard via session context, mirroring how other channel-aware tools are plumbed today.
- [x] In the tool wrapper, before delegating to the tool body, call `renderStatus(toolName, args, locale)` and emit the result when non-null.
- [x] Ensure a template or emission failure logs but never blocks or mutates tool execution.
- [x] Confirm status emission happens after permission/guard checks pass, not before, so the user is not told about tool calls that never run (revisit if this turns out to be the wrong call — see open questions in the feature doc).
- [x] Add tests covering: successful status for a representative tool in each supported locale, null-template tool (no status), emitter throwing, and guard-rejected tool (no status).

### Task 5: Wire channels to pass the emitter and locale into sessions
- [x] Update CLI session setup in `src/channels/cli.ts` to construct a `StatusEmitter` from the CLI outbound channel, resolve the locale from the environment, and pass both into the tool factory.
- [x] Update Telegram session setup in `src/channels/telegram.ts` similarly, resolving the locale from the sender's `language_code` on the incoming update.
- [x] Ensure shared session setup code in `src/channels/shared.ts` threads the emitter and locale through so both channels go through one code path.
- [x] Verify the emitter target channel tracks the correct `callerId` / chat per session, and the locale is recomputed per-turn so a user's language_code change takes effect without a restart.
- [x] Add channel-level tests that assert a tool invocation during a fake turn produces the expected status output on the right destination in the expected language.

### Task 6: Add config flags and safe defaults
- [x] Add `enableToolStatus` (default `true`) and `defaultStatusLocale` (default `"en"`) to `AppConfig` in `src/config.ts`.
- [x] Wire `enableToolStatus` through the tool factory so when disabled, the wrapper uses the no-op emitter and no status is sent.
- [x] Wire `defaultStatusLocale` into `resolveLocale` as the final step before the hardcoded English fallback.
- [x] Follow the existing `.env` persistence pattern (`PERSISTED_ENV_KEYS`) if the flags need runtime override.
- [x] Add tests covering flag-on and flag-off behavior at the factory level, and default-locale override behavior.

### Task 7: Confirm ephemerality and isolation from conversation state
- [x] Verify status messages do not appear in stored `full_history` for either channel.
- [x] Verify status messages are not included in rebuilt `runtime_context` and do not count toward compaction budgets.
- [x] Add regression tests proving that a turn with many tool calls produces many status messages but does not grow the stored assistant output beyond the actual reply.
- [x] Cross-reference the forced-checkpoints feature (`full_history != runtime_context`) in the test comments so the invariant is explicit.

### Task 8: Docs and rollout
- [ ] Update `docs/plan/README.md` active-plans table with this feature and link to this execution plan.
- [ ] Update `src/channels/README.md` to describe `sendStatus` and the ephemerality rule.
- [ ] Update `src/tools/README.md` (create if missing) with the template contract, redaction rules, and how to add a template for a new tool in every supported locale.
- [ ] Add an `src/i18n/README.md` (or inline doc) explaining the locale dictionary layout and the step-by-step process for adding a new language.
- [ ] Add a short note to `CLAUDE.md` pointing at the new docs so future contributors know to author a template alongside any new tool.
