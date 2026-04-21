# tools

LangChain tools handed to the agent. All file paths are virtual (in `backends/`).

## Status Emitter Contract

The `StatusEmitter` type (`status_emitter.ts`) provides short, human-readable status lines when tools are invoked. Status messages are **ephemeral** — they are not stored in conversation history and are not replayed into runtime context.

### Core Interface

```typescript
type StatusEmitter = {
  emit(callerId: string, message: string): Promise<void>;
};
```

- `callerId` — session identifier (e.g. `cli:username` or Telegram chat ID)
- `message` — localized, pre-truncated status string (e.g. "Reading a.txt", "Searching for X")
- **Must never throw** — emitter failures are caught internally and ignored

### Default Emitter

`noopStatusEmitter` is used when no channel supports status output. It is a singleton that does nothing.

### Creating an Emitter

```typescript
import { createStatusEmitter } from "./tools/status_emitter";

const emitter = createStatusEmitter(outboundChannel);
// Returns noopStatusEmitter if outboundChannel is undefined or lacks sendStatus
```

### Requirements for New Status Emitters

- Never throw — wrap all channel calls in try/catch
- Do not store messages in conversation history
- Keep messages short (max ~120 chars after interpolation)
- Sanitize messages: strip newlines, truncate oversized values

## Status Templates

The `status_templates.ts` module exposes `renderStatus(toolName, args, locale)` which returns a localized status string or `null` when no template exists for the tool.

### Dictionary Layout

Templates are organized as `locale → toolName → template`:

```typescript
const dictionaries: LocaleDictionary = {
  en: { read_file: "Reading {file_path}", ... },
  ru: { read_file: "Чтение {file_path}", ... },
  es: { read_file: "Leyendo {file_path}", ... },
};
```

Adding a new locale means adding a new top-level key with all tool templates. Missing translations fall back to English.

### Argument Allowlist

Each tool has an allowlist of safe arguments that may be interpolated:

```typescript
const ALLOWLISTED_ARGS = {
  read_file: ["file_path", "offset", "limit", "offsetLimit"],
  grep: ["pattern", "path", "glob", "pathGlob"],
  // ...
};
```

Only allowlisted args are interpolated. Values are truncated to 100 chars max, newlines are stripped, and the final message is capped at 200 chars.

### Adding a Template for a New Tool

1. Add the tool name to `ALLOWLISTED_ARGS` with an array of safe argument names
2. Add the template string to each locale dictionary (`en`, `ru`, `es`) using `{placeholder}` syntax
3. Ensure placeholder names match across all locales
4. If the tool is browser-based, add any special arg formatting in `buildInterpolatedArgs`
5. Add a test in `status_templates.test.ts` covering the new template in all locales

### Redaction Rules

- Paths and short identifiers are allowed
- Search patterns are allowed but truncated to 100 chars
- File contents, credentials, and long inputs are never included
- Array args with more than 5 items render as `[N items]`
- All newlines, carriage returns, and tabs are replaced with spaces

### No-template Fallback

When a tool has no entry in `ALLOWLISTED_ARGS`, `renderStatus` returns `null` and no status is emitted for that tool.

- `factory.ts` — `createExecutionToolset` assembles all tools, optionally wrapping each with the permissions guard
- `filesystem_tools.ts` — `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`
- `execute_tools.ts` — `execute_workspace`, `execute_script` (sandbox-backed)
- `memory_tools.ts` — `memory_write`, `skill_write`, `memory_append_log` (see [`src/memory/`](../memory))
- `task_tools.ts` — `task_add`, `task_complete`, `task_dismiss`, `task_list_active` backed by the shared SQL task store (`task_dismiss` requires explicit confirmation in the current user turn)
- `guard.ts` — `wrapToolWithGuard` — checks per-user policy, asks the broker, returns a denial string when blocked
- `echo_tool.ts` — sample tool, kept for parity
