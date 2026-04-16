# channels

Channel runtime adapters.

- `index.ts` — channel registry and dispatch by `APP_ENTRYPOINT`
- `cli.ts` — interactive local channel
- `telegram.ts` — multi-tenant Telegram channel
- `shared.ts` — shared agent-session helpers
- `session_commands.ts` — channel-agnostic session commands (`/new-thread` summarizes and rotates the thread)
