# GoodKiddo

Security-aware AI agent harness built with TypeScript and Bun.

- Agent with file tools, sandboxed execution, and per-user state
- Docker sandbox today, Firecracker path where supported
- CLI and Telegram entrypoints

## Run

Requirements: `bun`, `docker`, model API access.

```bash
./dev.sh
```

If config is missing, the app starts an interactive setup wizard.

## Read Next

- [`src/README.md`](./src/README.md) for the code map
- [`src/bin/README.md`](./src/bin/README.md) for entrypoints
- [`src/permissions/README.md`](./src/permissions/README.md) for the permission model
