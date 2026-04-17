# Repo Notes

- Do not use `pnpm --store-dir ...` in this repository.
- Use plain `pnpm ...` commands here.
- If `pnpm` reports an unexpected store location, fix the global pnpm `store-dir` to match the existing workspace install instead of passing `--store-dir` on each command.
- When a task changes behavior, setup, architecture, or operational workflow, update the relevant `README.md` docs before finishing the task.
