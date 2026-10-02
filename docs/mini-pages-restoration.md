# Static mini-page restoration and production handoff

Base: exact remote `restoration/2026-10-01-browser-cloud` SHA
`48169b70764b588a5eb85991718f84b3540a74fd`, verified 2026-10-02.
Known production release: `20261001-0b9d540-browser`. The historical main checkout
at `952807fd7db47752f83cd63a752b34b90b423850` remains untouched in
`/workspace/goodkiddo`. Implementation is in separate worktree
`/workspace/goodkiddo-mini-pages`, branch `restoration/2026-10-02-mini-pages`.

## Historical contract and chosen parity

In main, `bot/src/tools/share_tools.ts` implements `grant_fs_access`: virtual
artifact selection, `scope_path`, `ttl_hours` up to 24, URL
`https://app.whosagoodkiddo.me/fs/?uuid=...&path=...`, expiry returned to the agent.
`bot/src/server/routes.ts` supplies authenticated boot/preview/download; web UI
renders Markdown, images/PDF and highlighted code. No dedicated mini-page
publishing tool or public static-page endpoint was found in this main checkout.
The current assistant already preserves selected-file download links. HTML there
must remain an attachment, with no broader VFS/auth access.

This restores the requested outcome: the current author's Telegram request
creates a UTF-8 `.html` VFS artifact, then `publish_page` returns a working static
page link, ID, expiry and content restrictions. Default lifetime is 24 hours,
minimum one minute. A plain request to create a mini-page authorizes this flow;
a draft or publication prohibition authorizes file creation only. Forwarded,
scheduled, quoted and fenced instructions cannot authorize publication. The
guard is deliberately conservative and may require a clearer current request.

`list_pages` returns only current-chat publication IDs/titles/source paths/expiry.
`revoke_page` deletes only the current author's own publication in this chat.
Source file edits do not change earlier pages; republishing creates a new link.
URLs are returned at publication and persist in ordinary Telegram delivery;
only their SHA-256 hashes are in the publication table. Listing cannot recover a
lost URL. Repeating publication creates a separate bounded link, like existing
file grants; no exactly-once publication claim is made.

## Isolation and limits

The public route is `https://whosagoodkiddo.me/p/<32-random-byte-token>`, separate
from the private file application's origin. Only landing hostname and exact
token route are accepted. No directory, chat parameter, VFS route, file API,
cookie or bearer authentication is consulted by the page handler. Published bytes
are independent snapshots in additive `assistant_mini_pages`; queries to select
the source require the active chat. No host paths, subprocesses, model calls,
credentials, browser worker or server-side execution are used by publication.

HTML is parsed with the existing locked Cheerio dependency and serialized from
an allowlist. Scripts, event handlers, forms, frames, SVG/MathML, meta refresh,
base/link elements, relative URLs and external image/resource attributes are
removed. Inline CSS and PNG/JPEG/GIF/WebP data images work. HTTPS citation links
open only through an explicit user click into a new tab with noopener/noreferrer.
HTTP CSP adds an opaque-origin sandbox without allow-scripts/allow-same-origin,
`default-src 'none'`, inline styles, data images, no connections/forms/embedding.
CSS network requests are blocked by CSP, including @import/fonts/background URLs.
No cache, referrers, indexing, permissions, Set-Cookie or CORS grants are added.

Each sanitized page is at most 256 KiB. At most 20 live pages per chat and 1000
globally; page copies count against existing chat/global byte limits alongside
VFS files, document snapshots and file grants. Expiry is checked on every read,
with cleanup on quota checks and the existing maintenance tick. Revocation/expiry
release the copy without deleting source files or other chat state. `/clear`
invalidates stale in-flight tools but does not revoke already published pages.

## Infrastructure change requiring approval before activation

No production action was performed. No new key, paid API, account, service,
port, DNS, TLS, SSH or firewall setting is needed. Keep the existing GoodKiddo
account/service/SQLite and existing loopback `127.0.0.1:4184` file listener.
Default `MINI_PAGES_ENABLED` is off. `true` requires existing
`FILE_SHARES_ENABLED=true`; a busy port still fails startup without eviction.

The production integrator must obtain authorization to add just the `/p/`
location to the existing `whosagoodkiddo.me` nginx vhost. The reviewable fragment
is `ops/nginx-goodkiddo-mini-pages.location.conf`. It proxies to the same listener,
strips Cookie/Authorization, preserves sandbox headers, disables proxy cache and
token-bearing logs. Existing landing root, app vhost and scrapper stay unchanged.
Check actual vhost inheritance, Cloudflare caching rules and response CSP first;
do not apply this as a second/conflicting server block. If a security policy or
approval reviewer rejects this, stop that operation and report its target,
stated reason and smallest required permission. Do not use another route.

## Exact integrator sequence

1. Fetch the branch/checkpoint from this handoff, verify the base and final SHA,
   build from that exact commit using Bun and the locked dependency payload.
   Preserve the current code release, app configuration, voice's quiet behavior,
   Whisper cap $5/month Asia/Tbilisi, browser socket and every existing budget.
   Do not copy `.env`, keys, private data, database, host profiles or another
   project's dependency tree into an artifact. No production inference is needed.
2. Before mutation, confirm the production baseline/release and service-owned
   paths using authorized access. Stop only GoodKiddo for a consistent backup of
   its own `assistant.db` including WAL; retain its prior release and all queues.
   Do not inspect credentials or change scrapper. Confirm the existing listener
   on 4184 belongs to GoodKiddo; never kill an unrelated owner or select a new port.
3. Stage a separate GoodKiddo release with `dist/index.js` and its runtime-resolvable
   dependencies (existing PDF/CSV/XLSX workers still require their dependency
   trees). `bun run build` bundles the page parser; this feature adds no package.
   First activate with `MINI_PAGES_ENABLED` unset/false. Startup only adds its table
   and index. Existing file endpoints, scheduler, memory, voice/analytics/browser
   configuration and service confinement must remain intact.
4. After route/activation authorization, privately set only
   `MINI_PAGES_ENABLED=true` in the existing operator configuration; preserve
   `FILE_SHARES_ENABLED=true`. Include the reviewed location inside the landing
   vhost. Run `nginx -t` and reload only nginx after success; restart only GoodKiddo
   using its existing unit. Do not guess unit names or paths from sanitized source.
5. With synthetic inputs and no paid model, locally create/publish/read a page
   using the new store/handler; verify GET/HEAD, static CSS, exact headers, 404 for
   wrong token/host, absence of private VFS/auth access, and owner revoke. Use the
   integrator's approved Telegram test chat for one end-to-end request only if
   separately authorized. Confirm the returned HTTPS link opens from Telegram,
   CSS renders, scripts/external requests are blocked, and revoke returns 404.
   Public/proxy/browser verification is required before claiming deploy success.
   Do not send real voice or consume paid APIs to smoke-test this change.
6. Retain the additive page table during rollback. Disable/remove just the new
   `/p/` location and restore the previous compatible browser/file release and
   previous feature flag. Preserve current SQLite/queues, not an old database
   snapshot: reverting data would lose newer reminders/files/deliveries. The
   baseline ignores the extra table. Old page links become unavailable after
   code rollback; stored copies remain until new code resumes cleanup. Existing
   file links remain served by the previous file-capable release.

## Local verification

Use only synthetic SQLite/LLM/Telegram fixtures; no network model or Telegram
calls. New checks cover HTML allowlisting/CSP, exact host/token route, current
author authorization, expiry/revoke/quota, reopen and final same-chat delivery.

```sh
bun test ./checks/assistant-mini-pages.check.ts ./checks/assistant-mini-pages-integration.check.ts
bun x --no-install tsc -p checks/tsconfig-assistant.json
bun test ./checks/*.check.ts ./src/assistant/*.test.ts
bun x --no-install vitest run --config checks/vitest-restoration.config.ts
bun run test:analytics
bun run build
```

Environment preparation downloaded pinned Bun 1.3.11 into `/tmp` and installed
the existing lockfile with scripts disabled. No global runtime, production
service, private config, credentials or paid provider was accessed.

Verified checkpoint results (Bun 1.3.11, synthetic inputs only):

- Active assistant checks: 136 passed / 978 assertions, including six new page
  checks and full ingress → worker → tool → durable Telegram final → HTML GET.
- Browser/media/provider/document Vitest checks: 86 passed across nine files.
- Analytics: 11 passed / 51 assertions; the page-specific integration also checks
  that only the tool-name enum survives and URL/title/HTML are discarded.
- Active-runtime and integration-check TypeScript projects both pass; build passes
  (452 modules, 3.23 MB Bun bundle); `git diff --check` passes.
- Whole-repository `bun run typecheck` has a pre-existing error at
  `src/capabilities/browser/job.test.ts:49` (zero-argument mock tuple indexed at 0).
  It fails identically in a clean detached baseline worktree using the same
  dependencies. No browser code was changed to hide that failure.
- Whole-repository `bun run test` has the same 13 failed / 59 passed files and
  150 failed / 554 passed tests on both baseline and this checkpoint. The legacy
  Node tests cannot load the unbuilt `better-sqlite3` native binding in this
  scripts-disabled install; Vitest also cannot import three Bun-only suites.
  The active Bun and focused Vitest suites above pass separately. This is an
  existing tooling limitation, not a production or mini-page verification claim.

No live domain, browser sandbox enforcement, nginx configuration, production
database or Telegram delivery was verified remotely. Those remain the authorized
integrator's acceptance checks. Do not describe this source checkpoint as deployed.
