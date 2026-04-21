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

- `factory.ts` — `createExecutionToolset` assembles all tools, optionally wrapping each with the permissions guard
- `filesystem_tools.ts` — `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`
- `execute_tools.ts` — `execute_workspace`, `execute_script` (sandbox-backed)
- `memory_tools.ts` — `memory_write`, `skill_write`, `memory_append_log` (see [`src/memory/`](../memory))
- `task_tools.ts` — `task_add`, `task_complete`, `task_dismiss`, `task_list_active` backed by the shared SQL task store (`task_dismiss` requires explicit confirmation in the current user turn)
- `guard.ts` — `wrapToolWithGuard` — checks per-user policy, asks the broker, returns a denial string when blocked
- `echo_tool.ts` — sample tool, kept for parity
