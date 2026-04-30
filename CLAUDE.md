# CLAUDE.md

## Quick Context

- `docs/features/` holds high-level feature documents.
- `docs/plans/` holds execution-ready RALPHEX plans with ordered task sections and runnable validation commands.
- Prepared Follow-ups doctrine is documented in `docs/features/feature-prepared-followups-roadmap.md`: proactive work stays inside GoodKiddo-controlled safe space, outside-world final effects are unavailable by capability design, approval prompts must not unlock those effects, the user remains the final decider, and follow-ups should include prepared context, evidence, an artifact, a recommendation, or one specific missing detail after recall-before-asking.
- Bot database schema changes belong in paired dbmate SQL migrations under both `bot/db/migrations/sqlite/` and `bot/db/migrations/postgres/`. Use repo-root Bun scripts `bun run db:migrate`, `bun run db:status`, `bun run db:rollback`, and `bun run db:new -- <name>`; `db:new` creates a migration only for the currently selected dialect, so keep the paired version/name aligned. Bot startup runs migrations before constructing stores.
- `bot/src/capabilities/` holds reusable capability modules; voice transcription lives in `bot/src/capabilities/voice/`, PDF document parsing lives in `bot/src/capabilities/pdf/`, and CSV/Excel spreadsheet parsing lives in `bot/src/capabilities/spreadsheet/`.
- `bot/src/capabilities/attachment_budget.ts` is the shared code for deciding whether attachment output fits, requires compaction, or must be rejected before injection.
- Telegram channel behavior, including voice-message, PDF-document, and spreadsheet handling and limits, is documented in `bot/src/channels/README.md`.
- Voice transcription capability structure and provider extension points are documented in `bot/src/capabilities/voice/README.md`.
- PDF parsing capability structure and extractor interface are documented in `bot/src/capabilities/pdf/README.md`.
- Spreadsheet parsing capability structure and parser interface are documented in `bot/src/capabilities/spreadsheet/README.md`.
- Scheduled timers (`bot/src/capabilities/timers/`) let the agent run memory file prompts on cron schedules. Timer tools available to the LLM: `create_timer(mdFilePath, cronExpression, timezone?)`, `list_timers()`, `update_timer(timerId, updates)`, `delete_timer(timerId)`. See `bot/src/capabilities/timers/README.md` for cron format and notification backend extension points.
- Research sub-agent (`bot/src/capabilities/research/`) delegates investigation-heavy turns to a short-lived inner LangGraph agent with scoped browser sessions, recursion budgets, and read-only toolset. Notes are written to `research/<id>.md` in the workspace. See `bot/src/capabilities/research/README.md` for architecture and safe extension guidelines.
- Tabular query tools (`bot/src/capabilities/tabular/`) provide six structured tools for CSV/XLSX/Parquet files: `tabular_describe`, `tabular_head`, `tabular_sample`, `tabular_distinct`, `tabular_filter`, `tabular_aggregate`. Whitelisted operators/aggregations, capped limits, per-tool output budget. See `bot/src/capabilities/tabular/README.md` for the engine interface, supported formats, and how to add a new engine.

## Tool Authoring

When adding a new tool, author a status template alongside it so users see what the tool is doing.

- Template format, redaction rules, and how to add a template for a new tool: `bot/src/tools/README.md`
- Locale dictionary layout and how to add a new language: `bot/src/i18n/README.md`
- `sendStatus` interface and ephemerality contract: `bot/src/channels/README.md`

## Memory And Tasks

- Durable facts, preferences, and reusable procedures belong in `/memory/` and `/skills/`.
- Actionable work belongs in the SQL task store under `bot/src/tasks/`.
- Use task tools for open work. Use memory files for durable knowledge.
- `task_dismiss` is confirmation-gated: only dismiss after the user explicitly confirms in the current turn.

## Conversation State

- `full_history != runtime_context`.
- Full LangGraph history stays in SQL for audit and recovery.
- Model-facing runtime context is rebuilt from the latest forced checkpoint summary, recent turns, active tasks, and the current user input.
- Compaction boundaries are coordinated by `bot/src/checkpoints/compaction_trigger.ts`.

## Validation

- DB-backed tasks and notes:
  - `cd bot && bun test src/channels/shared.test.ts src/channels/session_commands.test.ts`
  - `cd bot && bun test src/tools/task_tools.test.ts src/tasks/store.test.ts src/tasks/reconcile.test.ts`
- Forced checkpoints and compaction:
  - `cd bot && bun test src/checkpoints/compaction_trigger.test.ts src/memory/checkpoint_compaction.test.ts src/memory/runtime_context.test.ts`

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%)
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->
