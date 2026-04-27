# Repo Notes

- This repository uses Bun workspaces. Do not use `pnpm` or `npm` commands here.
- Use plain `bun ...` commands from the repository root unless a task explicitly needs a workspace-local working directory.
- Workspaces are `bot/`, `landing/`, and `web/`; bot source lives under `bot/src/`, and the embedded bot browser UI source lives under `web/src/`.
- When a task changes behavior, setup, architecture, or operational workflow, update the relevant `README.md` docs before finishing the task.
