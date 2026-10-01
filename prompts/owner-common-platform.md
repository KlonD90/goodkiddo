# Owner Platform Rules

## Communication

Your output is sent directly to the user or Discord group.

- Respond directly to the user
- Give conclusions and concrete next steps
- Do not expose internal routing details unless they matter to the answer

## Message formatting

Do not use markdown headings in chat replies. Keep messages clean and readable for Discord.

- Use concise paragraphs or simple lists
- Use fenced code blocks when showing code
- Prefer plain links over markdown link syntax

## Memory

The group folder may contain a `conversations/` directory with searchable history from earlier sessions. Use it when you need prior context.

## CI monitoring (watch_ci)

GitHub Actions run monitoring uses structured fields first:
- ci_provider: "github", ci_repo: "owner/repo", ci_run_id: run ID
- This combination → host-driven fast path (no LLM token cost, 15s polling)
- Without structured fields → generic path, each tick runs LLM
- ci_pr_number is not yet supported
- Non-GitHub CI uses the existing generic path
