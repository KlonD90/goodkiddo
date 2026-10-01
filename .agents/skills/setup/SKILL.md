---
name: setup
description: Run initial EJClaw setup for the current EJClaw service architecture.
---

# EJClaw Setup

Start installation by bootstrapping with `bash setup.sh`, then complete the remaining steps with `bun run setup -- --step <name>`. EJClaw supports Discord channels and a basic Telegram adapter.

After setup, prefer the grouped subsystem folders under `src/` as the canonical layout. Top-level `src/` should stay minimal.

The `setup/` folder is also grouped:
- `setup/cli/` for the CLI entrypoint and prompt UI
- `setup/steps/` for the actual setup commands
- `setup/services/` for generated service files and service install/check logic
- `setup/platform/` for OS detection helpers
- `setup/state/` for setup-state summaries

When modifying setup code, start with `setup/README.md`.

EJClaw is made up of two services:
- **ejclaw** — Codex bot (`@Codex`)
- **ejclaw-codex** — Codex bot (`@codex`) — installed automatically when `.env.codex` exists

## 1. Bootstrap

```bash
bash setup.sh
```

- Node 20+ and dependencies must already be available.
- If this fails, check `logs/setup.log` first.

## 2. Check Current State

```bash
bun run setup -- --step environment
```

Use this step to confirm:

- whether `.env` exists
- whether any groups are already registered
- whether this installation has already been initialized

## 3. Required Environment Variables

### Codex Service (`.env`)

At minimum, `.env` should contain:

```bash
DISCORD_BOT_TOKEN=...                # Discord bot token
CLAUDE_CODE_OAUTH_TOKEN=...          # or ANTHROPIC_API_KEY=...
ASSISTANT_NAME=Codex                 # trigger name (@Codex)
```

Recommended:

```bash
CLAUDE_CODE_OAUTH_TOKENS=token1,token2   # auto-rotate across multiple accounts
GROQ_API_KEY=...                          # Discord voice transcription (Groq Whisper)
```

If you want Telegram, also add:

```bash
TELEGRAM_BOT_TOKEN=...               # Telegram bot token
```

### Codex Service (`.env.codex`)

Create `.env.codex` if you want to run the Codex bot alongside the main service. When this file exists, `--step service` also installs the `ejclaw-codex` service automatically.

```bash
DISCORD_BOT_TOKEN=...                # Codex bot token (separate from Codex)
```

Additional Codex settings can be defined either in the systemd unit with `Environment=` lines or directly in `.env.codex`:

```bash
# can be added in the systemd unit or .env.codex
CODEX_MODEL=gpt-5.4
CODEX_EFFORT=xhigh
OPENAI_API_KEY=...
```

### Optional Environment Variables

```bash
# usage dashboard
STATUS_CHANNEL_ID=...                # Discord channel for status updates
USAGE_DASHBOARD=true

# advanced settings
MAX_CONCURRENT_AGENTS=5
SESSION_COMMAND_ALLOWED_SENDERS=...  # user IDs allowed to run session commands (comma-separated)
```

## 4. Build Runners

```bash
bun run setup -- --step runners
```

This step builds the two runners below:

- `runners/agent-runner` (Codex)
- `runners/codex-runner` (Codex)

If this fails, usually the next things to inspect are the `bun run build:runners` output and the dependencies declared in each runner's `package.json`.

## 5. Register Channels

Discord JIDs use the format `dc:<channel_id>`. Telegram JIDs use the format `tg:<chat_id>`.

In dual-service mode, you can register the **same channel twice**, once for each agent type. Registrations are stored using the composite key `(jid, agent_type)`.

Register a Discord channel for the Codex bot:

```bash
bun run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #general" \
  --folder discord_main \
  --trigger @Codex \
  --is-main \
  --no-trigger-required
```

If the Codex bot should use the same channel, register it separately:

```bash
ASSISTANT_NAME=codex bun run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #general" \
  --folder discord_main \
  --trigger @codex \
  --is-main \
  --no-trigger-required
```

Example for a secondary channel:

```bash
bun run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #ops" \
  --folder discord_ops \
  --trigger @Codex
```

Example for Telegram:

```bash
bun run setup -- --step register -- \
  --channel telegram \
  --jid tg:123456789 \
  --name "Telegram chat" \
  --folder telegram_main \
  --trigger @Codex \
  --no-trigger-required
```

## 6. Start Services

```bash
bun run setup -- --step service
```

This command:
- always installs the **ejclaw** service
- also installs **ejclaw-codex** when `.env.codex` exists

Platform-specific outputs:
- Linux (systemd): `~/.config/systemd/user/ejclaw.service` + `ejclaw-codex.service`
- macOS: `~/Library/LaunchAgents/com.ejclaw.plist` + `com.ejclaw-codex.plist`
- WSL (no systemd): `start-ejclaw.sh` + `start-ejclaw-codex.sh`

Manual service management:

```bash
# Linux (systemd)
systemctl --user status ejclaw ejclaw-codex
systemctl --user restart ejclaw ejclaw-codex

# logs
journalctl --user -u ejclaw -f
journalctl --user -u ejclaw-codex -f
```

## 7. Final Verification

```bash
bun run setup -- --step verify
```

Success means:

- **ejclaw** is running
- **ejclaw-codex** is running when `.env.codex` exists
- Codex authentication is configured
- `CHANNEL_AUTH` includes at least one configured channel such as `discord` or `telegram`
- at least one group is registered

## Quick Troubleshooting

- Build issues: `bun run typecheck`, `bun test`, `bun run build:runners`
- Codex service issues: `logs/ejclaw.error.log` or `journalctl --user -u ejclaw -f`
- Codex service issues: `logs/ejclaw-codex.error.log` or `journalctl --user -u ejclaw-codex -f`
- Discord connection issues: verify `DISCORD_BOT_TOKEN` in `.env` and the registered `dc:*` JIDs
- Telegram connection issues: verify `TELEGRAM_BOT_TOKEN` in `.env` and the registered `tg:*` JIDs
- Response issues: `tail -f logs/ejclaw.log`
- When reading code after setup, start with `src/app/index.ts`, `src/runtime/message-runtime.ts`, and `src/agents/agent-runner.ts`
