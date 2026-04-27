# bin

Process entrypoints and admin scripts.

- `bot.ts` — main entry; resolves config and routes to a channel
- `admin.ts` — provisioning CLI (`add-user`, `list-users`, `list-rules`, `suspend`, `activate`)

Telegram access is explicit: add chats with
`bun src/bin/admin.ts add-user telegram <chat-id> "Display name"` before they
can use the bot. Unknown and suspended chats are blocked before session
commands such as `/open_fs` run.
