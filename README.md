# GoodKiddo

It's like a SaaS AI Agent but with little grain of security.

Beyond it some shit written by AI. I don't read personally so you shouldn't too.

`GoodKiddo` is an AI assistant built like a SaaS product, but designed with an open core mindset. The goal is simple: if software can read files, run tasks, and make decisions on a user's behalf, the implementation should be inspectable, self-hostable, and open to improvement.

This project is being open sourced because that feels like the right default for this kind of system. AI assistants should not be mysterious black boxes, especially when they can execute code or touch user data.

## What it is

- A TypeScript/Bun codebase for an agent-style AI assistant
- Tool-driven execution with workspace access and state persistence
- Sandboxed script execution through Docker today, with Firecracker support where the host allows it
- Built with LangChain-style agent tooling and a SQLite-backed workspace/state layer

## Security direction

This project is security-aware by design. The important idea is that generated scripts should not run directly on the host machine.

Current approach:

- Scripts are executed inside an isolated sandbox backend
- The Docker backend can disable networking with `--network none`
- Unsafe network access must be explicitly enabled for local development
- Execution sessions are created in temporary workspaces and destroyed after use
- Output artifacts are scanned and can be quarantined when they appear to contain PII

The intended direction is straightforward: give the assistant useful execution power without normalizing host-level arbitrary code execution.

## Local development

Requirements:

- `bun`
- `docker`
- A model endpoint compatible with the current `src/bin/bot.ts` setup

Run the project:

```bash
./dev.sh
```

If the required env vars are missing, the bot now starts a terminal wizard. Pick-one fields use a movable arrow-key selector, and text fields explain what each value is for before continuing.

Available entrypoints:

- `cli`: runs the current local CLI bot flow
- `telegram`: starts a Telegram polling bot using `TELEGRAM_BOT_TOKEN`

What `dev.sh` does:

- installs dependencies if needed
- builds the development container image if missing
- checks that the model endpoint is reachable
- runs tests
- starts the bot entrypoint

## Sandbox backends

- `docker`: default local development backend
- `firecracker`: preferred stronger isolation path on Linux hosts with `/dev/kvm`
- `auto`: uses Firecracker when supported, otherwise falls back to Docker

## Why open source

Because an AI assistant SaaS that can inspect files and run code should be open to audit. Openness makes the security model reviewable, the product easier to trust, and the system easier for others to adapt to their own infrastructure.
