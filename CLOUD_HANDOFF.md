# GoodKiddo source and runtime handoff

Use this branch as a complete source checkout. It preserves the current quiet voice behavior and the integrated file, core-state, scheduler, delivery, analytics, research and verified browser implementations. Do not replace persistent configuration, the shared assistant database, Linux dependency payloads or landing analytics configuration with source defaults.

Browsing remains disabled in a fresh checkout. An explicitly configured `ASSISTANT_BROWSER_SOCKET` accepts only `/run/goodkiddo-browser/worker.sock`. Runtime construction does not connect or launch a browser. A research browser read opens a fresh chat/task-owned job and closes it before the parent's final completion. Preserve document dispatch, delivery holds, generation cancellation, immutable recovery snapshots and persisted spending reservations.

The installed worker now passed public/private top-level redirect checks, fresh browser storage, the complete broker socket/public-link flow, cleanup acknowledgment and observed 60-second expiry. Its pinned image and confinement checks are documented in `docs/browser-worker-installation.md`. The integrated GoodKiddo runtime was enabled and verified with a harmless public-page request through the real configured free model and the complete parent → research → browser → final chain. Six shared model calls cost $0; the check sent no Telegram messages or analytics events and did not use the production database.

The worker exposes only snapshot, public href navigation and scroll. It uses a fixed Unix socket with no new HTTP listener, one active job, fresh rootless containers, native Chromium sandboxing, read-only root, zero capabilities, no direct network access, pinned public GET/HEAD egress, 1 CPU/1 GiB and a 60-second job deadline. Forms, login, uploads, shell/eval, arbitrary-code execution and browser state import are unavailable. No new provider, credential or spending cap is introduced.

Six installed rootful Podman vendor defaults remain separate from the dedicated rootless worker. They were inventoried without changes. Any cleanup must establish ownership and usage and receive its own scope; do not stop unrelated services or change shared host security. Arbitrary-code sandbox and static-page hosting remain disabled.

## Source verification

The published build matches the deployed bot bundle byte-for-byte by SHA-256. The complete focused suite passed: 141 Bun tests/879 assertions, 86 Vitest tests, four TypeScript checks and the active build. Temporary Unix-socket tests use mocked workers; they do not launch containers or contact providers. Explicit installed-worker fixtures under `checks/browser-*.verify.ts` perform runtime actions and must not be run as automatic setup.

The baseline excludes secrets and private runtime data. This follow-up retains that sanitization and updates only reviewed browser sources and verification documentation. Recreate dependencies in an isolated checkout and use focused restoration checks before future changes. Preserve the existing persistent analytics asset link and both hard monthly $5 spending caps when deploying subsequent releases. Natural owner Telegram interaction remains a separate end-to-end product check; the live model/browser verification described above was synthetic.
