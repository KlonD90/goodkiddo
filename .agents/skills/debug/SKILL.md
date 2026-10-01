---
name: debug
description: Debug EJClaw runtime issues on the current host-process architecture.
---

# EJClaw Debugging

EJClaw currently has Discord support plus a basic Telegram adapter, and agents run as host processes rather than containers. Narrow debugging in this order: `channel`, `service`, `runner`, `DB registration`, `credentials`.

Use the grouped subsystem folders as the canonical layout. Debug the grouped paths directly; top-level `src/` should stay minimal.

## Fast Debugging Checklist

1. Start with types and tests
   ```bash
   bun run typecheck
   bun test
   ```
2. Check service state
   ```bash
   bun run setup -- --step verify
   ```
3. Check runtime logs
   ```bash
   tail -f logs/ejclaw.log
   tail -f logs/ejclaw.error.log
   ls -t groups/*/logs/agent-*.log | head
   ```
4. Check runner builds
   ```bash
   bun run build:runners
   ```

## Key Files

- `src/app/index.ts` - service startup and top-level orchestration
- `src/runtime/message-runtime.ts` - message loop and turn decisions
- `src/channels/discord.ts` - Discord input/output, mentions, attachments, voice transcription
- `src/channels/telegram.ts` - Telegram long polling, message normalization, outbound send/edit
- `src/agents/agent-runner.ts` - runner launch, environment propagation, working directory handling
- `src/providers/credential-proxy.ts` - provider-aware credential proxy for reviewer isolation
- `src/providers/credential-providers.ts` - model/provider resolution
- `runners/agent-runner/src/index.ts` - Codex runner
- `runners/codex-runner/src/index.ts` - Codex runner
- `src/persistence/db.ts` - registered groups, sessions, schedule storage
- `setup/steps/register.ts` - channel registration
- `setup/steps/verify.ts` - installation verification
- `setup/services/verify-services.ts` - service probing
- `setup/state/verify-state.ts` - setup-state summaries

## Common Issues

### The Bot Does Not Respond At All

```bash
grep -n '^DISCORD_BOT_TOKEN=' .env
grep -n '^TELEGRAM_BOT_TOKEN=' .env
bun run setup -- --step verify
```

- If `DISCORD_BOT_TOKEN` is missing, the bot cannot connect to channels.
- If `TELEGRAM_BOT_TOKEN` is missing, the Telegram adapter cannot connect.
- If `REGISTERED_GROUPS=0`, no channels have been registered.
- If the channel is not marked as main, check mention rules or trigger requirements first.

### The Agent Dies Immediately After Starting

```bash
grep -nE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_OPENAI_API_KEY)=' .env
ls -t groups/*/logs/agent-*.log | head -3
```

- Codex-based agents need `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`.
- Codex-based agents need `OPENAI_API_KEY` or `CODEX_OPENAI_API_KEY`.
- Runner logs usually show authentication failures or CLI execution errors right away.

### Voice Transcription Does Not Work

```bash
grep -nE '^(GROQ_API_KEY|OPENAI_API_KEY)=' .env
tail -f logs/ejclaw.log | grep -iE 'transcri|audio|whisper|groq'
```

- Groq Whisper is used first, with OpenAI Whisper as the fallback.
- Without one of these keys, Discord audio attachments cannot be expanded into text.

### The Channel Is Registered But Replies Are Wrong

```bash
sqlite3 store/messages.db "select jid, folder, requires_trigger, is_main, agent_type from registered_groups;"
```

- `jid` must use the format `dc:<channel_id>` or `tg:<chat_id>`.
- `folder` should stay in the form `discord_main` or `discord_<name>`.
- If it looks like a session-command issue, inspect both `src/runtime/session-commands.ts` and the call sites in `src/app/index.ts`.

## Principles

- Keep channel problems and agent problems separate.
- A bad `.env`, broken DB registration, service issue, or runner build problem can all produce similar top-level symptoms.
- Ignore old container-based docs and verify against `runners/*` and `setup/*` instead.
