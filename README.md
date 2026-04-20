# GoodKiddo

Security-aware AI agent harness built with TypeScript and Bun.

- Agent with file tools, sandboxed execution, and per-user state
- Per-caller memory wiki (notes, skills, log) with `/new-thread` rotation
- Persistent LangGraph conversation checkpoints stored in a database configured via `DATABASE_URL` (SQLite by default)
- Docker sandbox today, Firecracker path where supported
- CLI and Telegram entrypoints, including Telegram photo messages for multimodal models

## Run

Requirements: `bun`, `docker`, model API access.

Database config uses `DATABASE_URL` only, for example `sqlite://./state.db`.

```bash
./dev.sh
```

If config is missing, the app starts an interactive setup wizard.

## Plans

- [`docs/plan/`](./docs/plan/) — high-level feature plans
- [`docs/plans/`](./docs/plans/) — execution-ready RALPHEX-aligned implementation plans

## Read Next

- [`src/README.md`](./src/README.md) for the code map
- [`src/channels/README.md`](./src/channels/README.md) for the CLI and Telegram channels, including Telegram formatting and troubleshooting
- [`src/bin/README.md`](./src/bin/README.md) for entrypoints
- [`src/permissions/README.md`](./src/permissions/README.md) for the permission model
- [`src/memory/README.md`](./src/memory/README.md) for the memory subsystem
