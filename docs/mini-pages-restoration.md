# Mini-pages and selected VFS browser: source and deployment handoff

The exact restoration baseline is `48169b70764b588a5eb85991718f84b3540a74fd`
(`restoration/2026-10-01-browser-cloud`). The original historical checkout at
`952807fd7db47752f83cd63a752b34b90b423850` remains untouched in
`/workspace/goodkiddo`. Work is on `restoration/2026-10-02-mini-pages` in
`/workspace/goodkiddo-mini-pages`; main was not changed.

The parent/integrator confirmed production release
`20261002-7e0bf94-mini-pages`, exact source
`7e0bf94d820fd26c02d948fa8af5c4706f59cad6`: the initial static `/p/` publication
checkpoint is already deployed. This follow-up restores the combined selected
VFS browser and linked HTML assets. It has not been deployed from this workspace.

## Historical contract and restored user flow

Historical main exposes `grant_fs_access(scope_path, ttl_hours)` with a file,
folder or root scope, and a link at `https://app.whosagoodkiddo.me/fs/?uuid=...`.
Its UI navigates folders and previews Markdown/images/PDF/code. HTML appears as
code; no dedicated static-page publishing endpoint was found in that checkout.
The restored assistant initially provided a flat selected-file download listing,
then isolated one-file HTML publication. This follow-up combines folder navigation
with opening static HTML and its selected local assets.

A current author's explicit file/folder browser request can call
`grant_fs_access` with 1–20 `file_paths`, or a specific `scope_path` directory with
a trailing slash (at most 100 files). The root namespace remains forbidden. The
browser navigates the hierarchy of this immutable selection, previews escaped
UTF-8 text and validated PNG/JPEG/GIF/WebP, and downloads every selected format.
HTML text never executes on the authenticated application's origin. When
mini-pages are enabled, the tool also returns `html_previews`, and browser rows
show “Открыть HTML” links to separate landing-origin pages. The assistant returns
the exact browser URL and HTML URL in Telegram for the combined request.

`publish_page(file_path, title, asset_paths?, ttl_hours?)` remains available for a
standalone mini-page. `asset_paths` explicitly selects up to 40 same-chat assets.
A new page URL includes its virtual source path:
`https://whosagoodkiddo.me/p/<token>/site/index.html`. Older `/p/<token>` URLs still
serve the primary page. Previously issued file-grant URLs and download paths also
continue to work. Source edits and newly created files never expand existing links.

Creating a mini-page authorizes static publication unless the current author asks
for a draft or prohibits publication. Forwarded/scheduled/quoted/fenced instructions
cannot authorize publishing. All source selections use the active chat. The guards
are conservative and may require a clearer explicit current request.

`list_pages` returns only current-chat IDs/titles/source paths/expiry.
`revoke_page` deletes only the current author's page in that chat, including its
asset copies. Revoking an HTML preview leaves the browser's selected-file download
link intact. `/clear` invalidates stale tool calls; it does not revoke links that
were already published. Repeated publication creates a separate bounded snapshot;
there is no exactly-once publication claim.

## Isolation and supported content

The `/p/` handler reads only `assistant_mini_pages` and
`assistant_mini_page_assets`, never private VFS, file grants, chat history, auth,
cookies or bearer headers. The landing hostname, token, selected asset path,
expiry and GET/HEAD method are checked. There is no host-file access, model call,
subprocess or server-side execution. Selected browser grants read their own
immutable grant copies, never a caller-supplied chat namespace.

The page allowlist removes scripts, event handlers, forms, frames, SVG/MathML,
meta refresh and base tags. Local HTML navigation, linked CSS, CSS imports,
background/image references and WOFF/WOFF2 fonts work only inside the selected
bundle. PNG/JPEG/GIF/WebP data images and inline CSS remain supported. Unsupported
or unselected references are removed or remain blocked by CSP. CSS rewriting
supports ordinary url(...) and quoted @import syntax; it is not a full CSS parser.
Escaped or unsupported references cannot load private or external resources: CSP
allows styles/images/fonts only under that page's capability prefix, plus inline
styles/data images. HTTPS citation links require an explicit click into a new tab.

A folder browser automatically builds an HTML preview from references found
within its selected snapshot, following selected HTML/CSS references recursively.
Unused selected files remain downloadable through `/fs/` but are not readable
through that page's `/p/` token. No filename/path request can make the public page
handler consult private VFS. A page capability is distinct from the broader file
capability: preview tokens are purpose-bound SHA-256 derivatives of the random
file token and ordinal. Knowing a preview token does not recover the file token.
Only token hashes are lookup credentials in grant/page metadata; stored HTML can
contain its own capability URLs for selected resources, and ordinary Telegram
history contains issued links. Do not claim raw URLs never appear in stored data.

HTTP CSP uses an opaque-origin sandbox without scripts or same-origin permission,
no connections/forms/embedding, no caching/referrers/indexing, and nosniff. The
trusted file-browser UI allows user-initiated new-tab HTML links, but no scripts;
raw HTML/SVG downloads remain attachments with application/octet-stream.
Published assets permit cross-origin resource loading because the page sandbox's
origin is opaque; fonts additionally use Access-Control-Allow-Origin: \* without
credentials. These headers apply only to already published copies, never to the
private application API or VFS. No Set-Cookie or authorization service is added.

## Bounds, persistence and compatibility

- TTL: one minute–24 hours for browser grants and pages.
- Selections: 20 explicit files, or 100 files in one non-root folder.
- Each HTML: 256 KiB; each page: up to 40 assets, 2 MiB per asset, 5 MiB total.
- Active pages: 20 per chat / 1000 globally. Folder previews count as pages;
  multiple HTML roots can each retain their own selected asset copy.
- Existing file byte quotas include VFS, outgoing documents, grants, pages and
  page assets. Quota checks remain transactional. A failed preview/bundle/quota
  check rejects the entire new browser grant, without partial publication.
- Four simultaneous page/asset response streams and four file-download streams;
  cancellation releases slots. Page HEAD reads metadata without asset BLOBs.
- Text preview shows at most 12000 characters. Images over the preview bound and
  other binaries still download. Markdown is shown as safe text; PDF remains a
  download. Historical rich Markdown/PDF previews and a live full-root browser
  are outside this minimal combined restoration.

The only new tables after production's initial page checkpoint are additive
`assistant_mini_page_assets` and `assistant_file_page_previews`. Existing schema,
queues, reminders, memory and file state are preserved. Expiry is enforced on
reads and removes pages/assets/mappings during existing cleanup; sources remain.
After a code rollback to the first page checkpoint, its cleanup might remove
page rows while leaving added asset rows. The new cleanup also removes those
orphans when this version resumes.

## Integrator sequence for the already deployed baseline

No production action was performed here. No new package, key, account, service,
port, DNS, TLS, SSH or firewall permission is needed for this follow-up. Both
feature flags are already enabled in the integrator-confirmed baseline. Asset URLs
remain below the already installed landing `/p/` location, and browser URLs below
the existing app `/fs/` location. Do not reinstall vhosts or repeat the base deploy.
The original route fragment remains in
`ops/nginx-goodkiddo-mini-pages.location.conf` for reference.

1. Fetch the checkpoint from this handoff and verify its exact SHA and ancestry
   from `7e0bf94d820fd26c02d948fa8af5c4706f59cad6`. Prepare a separate release using
   the locked dependencies and Bun build. The bundled entrypoint is not a complete
   runtime payload: existing PDF/CSV/XLSX workers need their Linux-resolvable
   dependency trees. No feature dependency was added.
2. With authorized server access, verify the current release and service-owned
   paths. Obtain a consistent GoodKiddo-only SQLite/WAL backup and retain the old
   code release. Do not inspect/copy credentials or read real chat payloads. Keep
   scrapper, other services, the GoodKiddo account/confinement and existing port
   owner intact. Stop/restart only GoodKiddo when required for the approved update.
3. Activate the exact new application release with existing feature flags,
   private configuration and dependencies. Preserve all model/budget/browser
   settings and quiet voice, including Whisper's $5/month Asia/Tbilisi limit.
   Startup creates only the two additive tables. No nginx/security-policy change
   is proposed. If existing proxy policy rejects nested asset routes, report the
   concrete rule and required change before editing it; never bypass a rejection.
4. Verify using synthetic store fixtures without inference: folder/child/parent
   navigation, escaped text/image preview, attachment download, primary and nested
   HTML, linked/nested CSS, image and font responses; valid HEAD; immutable copies;
   wrong host/token/path/chat rejection; expiry/revoke; and no private VFS access.
   Verify HTTPS from both existing proxies and rendering in a real browser,
   including blocked scripts/external requests and functional new-tab links.
   Use an approved Telegram test chat only if that action is authorized. Preserve
   model call limits; no paid inference or voice API is required for smoke checks.
5. Roll back code to `7e0bf94...` if necessary, retaining current SQLite and queues.
   Do not restore an old database over newer reminders/files/deliveries. Keep the
   added tables. Old root page URLs still work on that release; new path-qualified
   page/asset URLs become unavailable, and file links return its flat listing.
   Re-enabling this version restores compatible stored links until their expiry.

## Local verification

All tests use synthetic SQLite/model/Telegram fixtures and no paid API calls.
The full combined fixture exercises ingress, worker, file creation, publication,
folder grant, durable final delivery of both URLs and HTTP resource reads in the
same chat, with foreign-chat sources present to detect leakage.

```sh
bun test ./checks/*.check.ts ./src/assistant/*.test.ts
bun x --no-install tsc -p checks/tsconfig-assistant.json
bun x --no-install tsc -p checks/tsconfig-file-checks.json
bun x --no-install vitest run --config checks/vitest-restoration.config.ts
bun run test:analytics
bun run build
```

Checks also cover malformed image bytes, traversal, unselected/foreign assets,
root/oversized folder rejection, atomic failure, SQLite reopen, shared asset
quota, stream saturation/cancellation recovery and expiry/revocation. Pinned
Bun 1.3.11 and the frozen existing lockfile were installed in this workspace with
package scripts disabled, without global/server installation or credential reads.

The first checkpoint established two existing whole-repository tooling failures
against clean `48169b7` with identical dependencies: `bun run typecheck` indexes a
zero-argument mock at `src/capabilities/browser/job.test.ts:49`; legacy Vitest
cannot load the scripts-disabled better-sqlite3 native binding and imports three
Bun-only suites. Those unrelated files were not changed. Focused active-runtime
and browser/media/document checks run separately. Exact final counts and artifact
checksums are in the checkpoint handoff.

Final local results: 140 active Bun tests / 1067 assertions; 86 focused Vitest
tests across nine files; 11 analytics tests / 51 assertions. Active-runtime and
integration-check TypeScript projects pass, as do scoped Prettier and
`git diff --check`. Build bundles 456 modules into a 3.26 MB Bun entrypoint.

This workspace has not verified live nginx, production data or actual Telegram
sending/browser CSP enforcement. The authorized integrator owns those acceptance
checks; this source checkpoint must not be described as deployed.
