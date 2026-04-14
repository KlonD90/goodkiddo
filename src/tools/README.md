# tools

LangChain tools handed to the agent. All file paths are virtual (in `backends/`).

- `factory.ts` — `createExecutionToolset` assembles all tools, optionally wrapping each with the permissions guard
- `filesystem_tools.ts` — `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`
- `execute_tools.ts` — `execute_workspace`, `execute_script` (sandbox-backed)
- `guard.ts` — `wrapToolWithGuard` — checks per-user policy, asks the broker, returns a denial string when blocked
- `echo_tool.ts` — sample tool, kept for parity
