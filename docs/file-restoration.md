# File restoration implementation checkpoint

Source is isolated in branch `restore-chat-files` based on September `455e5be`, with the already deployed public-inference and group-handler fixes preserved. The original Mac repositories, production service and production database are unchanged.

Implemented storage primitives: `AssistantFiles` in `src/persistence/assistant-files.ts`, with list/read/write/edit/glob/literal grep; binary-safe BLOB storage; MIME validation; normalized virtual paths; incoming-upload origin deduplication; bounded reads/search results. Every storage query requires a chat ID. Paths resolve only inside SQLite, never to the host filesystem. Existing filenames are not silently overwritten.

Limits default to 20 MiB per file, 100 MiB and 1000 files per chat, 1 GiB across GoodKiddo file storage. Quota checks run in the same transaction as writes/edits. Persisted outgoing snapshots and prepared browser-grant snapshots count against the same byte quotas. Finished/cancelled delivery payloads are released.

The additive `assistant_files` table leaves previous schema/data intact. Existing synthetic chats and pending text deliveries survived schema initialization and repeated reopen; new virtual files persisted across reopen.

Validation: `bun test ./checks/assistant-files.check.ts`; isolated typecheck `bunx tsc -p checks/tsconfig-files.json`. Checks use only scratch SQLite databases and synthetic file contents, with no live model/Telegram messages. The previous schema fixture is a snapshot of the deployed pre-file schema.

Implemented second checkpoint: ls/read_file/write_file/edit_file/glob/grep/send_file are exposed in the active assistant registry; Telegram getFile downloads are capped before and during streaming; document-only intake stores a file and acknowledges it without a model call. Group intake still requires addressing the bot. Forwarded document captions and slash captions cannot execute commands. Upload metadata preserves the source timestamp, and repeated update IDs do not redownload or overwrite edited files.

Document sending uses immutable snapshots in a durable same-chat ledger and the existing outbox. Retries retain the payload; terminal failures/cancellations release it. Turn-scoped delivery holds prevent an early document from completing the task before the final reply is queued. Replays of completed identical operations are deduplicated. Telegram cannot provide exactly-once delivery after an ambiguous transport timeout/crash; a delivery might repeat in that case.

Validation now passes 14 tests / 103 assertions across storage and document checks, plus the complete active-runtime typecheck `tsc -p checks/tsconfig-assistant.json`. Tests cover document-only/caption/group/forwarded routing, upload-origin replay, source time, fixed Telegram host and multipart sending, bounded streaming, same-chat destination, immutable snapshots, persistent queue reopen, turn holds, 429 retry, permanent 400 failure and shared snapshot quota. No live Telegram messages or model requests were used.

Implemented third checkpoint: grant_fs_access creates immutable snapshots of 1–20 selected current-chat files only after an explicit current-author request for a browser file link. Forwarded requests, quoted context, uploaded contents and plain file creation do not authorize publication. The runtime intent guard is conservative and may ask for a clearer explicit request. Tokens contain 32 cryptographic random bytes; only SHA-256 token hashes are stored in grant tables. TTL is bounded to one minute–24 hours, with at most 20 active grants per chat / 1000 globally. Byte quotas include snapshots. Expiry frees snapshots without deleting original files.

The endpoint preserves the historical URL shape https://app.whosagoodkiddo.me/fs/?uuid=... and shows only granted snapshots. Downloads always use attachment disposition and application/octet-stream, even for HTML/SVG; filenames are escaped; no caching, referrers or scripts are permitted. Unknown/expired links and invalid file paths return the same 404. HEAD is supported without reading the BLOB. Download concurrency is capped at four. The loopback listener is disabled by default (FILE_SHARES_ENABLED=true enables it) and binds only 127.0.0.1:4184; a busy port fails startup without evicting services or choosing another port.

Validation now passes 22 tests / 189 assertions, active-runtime typecheck, scratch tests typecheck and Bun build. New checks cover hashed/random tokens, explicit request and forwarded/quote rejection, selected-file/chat isolation, immutable snapshots, expiry, quota release, malicious paths/names, safe HTML downloads, SQLite reopen and concurrent cancellation. A complete synthetic model turn exercises write/read/send/link/final response through ingress, worker, persistent queues and delivery. Interrupted-turn recovery releases holds, preserves the file delivery and records cancellation instead of false success.

Still pending: final combined release packaging and integration with separately owned core/media restoration commits. PDF/CSV/XLSX extraction or voice/image understanding is not claimed by this checkpoint.

Browser grants were approved in the parent conversation. The user selected the existing `https://app.whosagoodkiddo.me/fs/` address instead of the initially proposed landing /files/ route. The prepared `ops/nginx-goodkiddo-app.conf` adds only that isolated app vhost and proxies `/fs` and `/fs/` to an isolated loopback GoodKiddo listener at `127.0.0.1:4184` (read-only host check confirmed this port unused on 2026-09-30). Tokens use 32 random bytes, are stored hashed and expire within 24 hours. Grants contain only explicitly selected current-chat file snapshots. No root listing, cross-chat grant, host filesystem access, or arbitrary remote URL is introduced. Downloads use attachment disposition, safe MIME policy, no-store caching and no token-bearing access logs. No browser route is installed at this checkpoint.

The parent forwarded conditional approval for port 4184 only while free, and the user explicitly selected/updated DNS for app.whosagoodkiddo.me. Recheck the port immediately before enabling, install/test only the app vhost, then reload nginx without changing existing vhosts. Public DNS resolves to Cloudflare proxy addresses and HTTPS was certificate-valid with HTTP 404 before publication (2026-09-30 19:54 UTC). No firewall, SSH, account, shared scrapper route or port 443 change is proposed. Production activation also creates additive file/grant/delivery tables in GoodKiddo's own SQLite; make a GoodKiddo-only consistent backup, retain the previous code release, and document how pending new document deliveries are preserved during rollback.

Integration ownership: core worker must preserve delivery_hold startup/process/finally hooks and document send selection/cleanup when merging its worker/delivery changes. Its forwarded-text command protection and /clear generation guard remain independent; document captions are already protected here. Media worker must preserve fixed-host getFile/download transport and document metadata when extending TelegramMessage.

Rollback constraint: the original September release does not recognize document outbox entries. Do not downgrade it against a database with pending document deliveries, or captions could be sent as text and the documents lost. Retain a file-capable compatibility release (this checkpoint) alongside the later combined release; stop only GoodKiddo for a consistent own-database backup, preserve new tables/queues during code rollback, and keep the loopback/public route disabled if that compatibility release cannot serve it. No production rollback or database mutation has occurred during preparation.

Combined integration checkpoint: core memory/TODO 44f7012 -> 1505fc3; core clear/forwarding/delivery dcd9de5 -> 298fbb2; media modules cdf3fa4 -> e4f4b9f; media runtime e70267b merged with current-author link guards, context versions and file holds. 50 Bun tests / 331 assertions and 41 Vitest module tests passed; active-runtime and integration-test typechecks passed. Private visible-content drafts and group previews are closed on context clear, and context is checked again after waiting for their final close. Earlier-selected outbox rows are checked again after intervening API calls, so cancellation in another chat suppresses their later send.

Production packaging must include runtime-resolvable pdf-parse, csv-parse/sync and ExcelJS dependency trees because extraction workers resolve their package paths at runtime. Mac native optional modules cannot be used on the Linux host; prepare a locked Linux dependency payload and validate PDF/CSV/XLSX in the actual Bun runtime before activating. These are per-release application dependencies; no global package/OS install or voice model has been performed.

## Cloud parity regressions

The synthetic full-turn check now verifies exact VFS bytes through both the
Telegram document mock and the download handler, with a different file at the
same path in another chat. A download query parameter cannot select that other
chat. Mixed selections containing a foreign-only file fail atomically without
creating a partial grant or snapshot. Capabilities remain bearer links: possession
of a valid link permits its selected snapshots until expiry; this is not Telegram
chat authentication. Existing tests cover cancellation of queued documents and
stale link tools after `/clear`, plus download stream cancellation and slot reuse.

## Selected VFS browser and isolated HTML follow-up (2026-10-02)

The follow-up to deployed `7e0bf94...` adds hierarchical navigation of a selected
immutable folder (at most 100 files; root forbidden), safe text/image previews,
and separate landing-origin HTML previews with only referenced selected assets.
Existing selected-file links and attachment downloads remain compatible. HTML
never executes on the app origin, and the public page handler never queries VFS
or file-grant tables. Limits, new additive tables, rollback behavior and the
integrator-only deployment sequence are in `docs/mini-pages-restoration.md`.
The folder snapshot is not a live namespace; newer files/edits remain private.
