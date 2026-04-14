# bin

Process entrypoints. Pick one based on `APP_ENTRYPOINT`.

- `bot.ts` — main entry; resolves config and routes to CLI or Telegram
- `cli_runner.ts` — interactive REPL; auto-seeds local user with permissive policy
- `telegram_runner.ts` — multi-tenant bot polling loop; pre-LLM gate blocks unknown chats
- `admin.ts` — provisioning CLI (`add-user`, `list-users`, `suspend`, `activate`)
