# Public restoration source snapshot

This branch exports the tracked source at commit `5a0e39c1474943110728afbfa6a0174dfb123de5` (source tree `9fbcaa930f948b9c83809ad904e1098dc3cc3aee`). It is a standalone source snapshot with a single root commit, separate from the repository default branch. Local development and deployment history are not included.

The snapshot preserves 356 of 368 tracked source files. 339 retained files are byte-identical; 17 contain publication sanitization. `SOURCE_SNAPSHOT.json` records relative paths and SHA-256 hashes for reproducibility. Active Telegram assistant code is byte-identical to the source snapshot.

Publication changes remove a personal Discord mention binding, replace credential-shaped synthetic test values with explicit fixtures, replace developer paths and deployment host details with placeholders, and update documentation links after excluding environment templates. The original `LICENSE` and upstream attribution are preserved unchanged. This export does not change licensing of historical repository revisions.

Excluded files are environment templates, local agent/MCP settings, personalized legacy group instructions, provider smoke evidence and its image, and the CI workflow. The existing OAuth authorization does not permit creating workflows, so no workflow is published in this source branch; the test sources and configuration remain included. No database, conversation history, logs, credentials, recovery archive or deployed runtime data is included. Configuration keys are documented in `src/config/assistant-config.ts` and `src/config/config.ts`; use private environment values supplied by your operator.

The legacy Discord mention map is now empty; configure any desired mapping explicitly. Nginx configuration uses `app.example.invalid` as a host placeholder. Public product links, source references and upstream notices remain.

This is source publication only. It neither starts services nor activates schedules. Browser execution is not included in this snapshot; separate handoff patches, if provided on another branch, must be reviewed and integrated independently.

Local export verification passed: full TypeScript typecheck, active Bun entrypoint build, 100 synthetic restoration/analytics tests (623 assertions), and 91 tests covering the sanitized legacy modules. No live provider calls, Telegram messages or production changes were performed. These checks do not prove every retained legacy feature works; the remaining legacy suite was not run for this export.
