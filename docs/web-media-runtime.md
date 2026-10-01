# Connected web/media/rich-message runtime

This follows the independent `cdf3fa4` capability checkpoint and is built against the file coordinator's `f86a24a`. The coordinator repository was imported into the separate `restore-web-media-formatting` branch; it was not edited. Cherry-pick the subsequent **runtime wiring commit only** after `cdf3fa4` and the coordinator file/core changes. Do not cherry-pick the local merge commit. No service startup, deployment, credentials, or live Telegram message was involved.

## Runtime behavior

`toolDefinitions` and `executeTool` now expose and dispatch `read_url`, `extract_file`, and `describe_image` alongside all restored virtual file tools. These use the current chat and preserve the file worker's dispatcher. Supplied URL reading is independent of Brave/search keys; all public-IP, redirect, size, and timeout limits remain in force.

Telegram photos pass the same private/mention/reply gate before downloading. The largest variant is validated and stored as a JPEG in that chat's VFS, with origin deduplication, quotas and source timestamp. An ordinary photo becomes a current-turn image request; forwarded photos are stored with an acknowledgement and their captions are not executed. Photo captions cannot run slash commands. Stored PNG/JPEG/WebP documents can be understood through `describe_image`.

Image support is enabled for the already-verified public no-auth `space-bunny-free` endpoint/model only. Other configured providers receive an explicit unsupported-capability result instead of silently switching models or credentials. Photo bytes are attached to metered completions, not text history or analytics. `describe_image` also uses `meteredCompletion`; image bytes enter the conservative reservation, reported usage settles it, and the total per-task LLM call cap includes nested vision calls.

The agent forwards visible SSE content snapshots through the worker to `TelegramTurnPreview`. Private chats use throttled/coalesced `sendRichMessageDraft` calls with a stable nonzero draft ID and optional topic ID. Group chats create one placeholder, persist its message ID, and stream progress through `editMessageText` at intervals of at least 3.2 seconds. Reasoning and tool arguments never enter these snapshots. Each model round replaces the previous snapshot rather than appending to it.

The worker closes/awaits previews before releasing `delivery_hold`. The final reply remains in the durable outbox. In groups the first final chunk edits the persisted preview message; remaining chunks, if any, are sent normally. Interrupted group runs reuse the same preview for the recovery reply. Documents still pass through the coordinator's immutable document queue and continue obeying delivery holds.

Text transport now uses native `sendRichMessage` with exactly `rich_message: { markdown }`. Long replies split at Markdown boundaries: table headers repeat, fenced code remains balanced, Unicode is preserved, and overly wide/large tables become complete labelled field prose. Chunks stay under 3500 characters and comfortably below Telegram block limits. Raw HTML and remote media embeds outside code are escaped/removed; code examples keep their literal contents. Plain fallback occurs only after a definitive unsupported-method 404.

## Delivery guarantees and tradeoff

`assistant_reply_previews` and `assistant_text_deliveries` are additive tables created by `ensureTextDeliverySchema`; they do not replace existing outbox, file, chat, history, or task tables. Preview IDs are durable and scoped to the same run/chat. Text receipts remember pending/sending/sent/uncertain states and topic/message targets.

Editing a known group message is idempotent and retryable. Telegram's `message is not modified` result acknowledges an already-applied final edit. A crash after a confirmed final send but before outbox cleanup sees the saved sent receipt and does not send again.

Telegram provides no general idempotency key for a new final send. On a timeout/network error/5xx, or a restart while a new send was in progress, the outcome is marked uncertain and automatic resend is suppressed. The chat queue is released and the uncertain receipt is retained. This prevents duplicate finals but cannot promise delivery after an ambiguous transport failure. Definitive 429 rejections still follow `retry_after`; known-message edits can safely retry. No automatic second final/fallback follows an uncertain new send. Operator reconciliation or an explicit user retry is needed if the final was not received.

Draft stop buttons remain disabled; no unwired cancellation promise is shown. Topics are preserved for streamed requests and their final text chunks. Existing chat context/VFS scoping remains per chat, not separately per forum topic.

## Voice finding and exact requirement

Historical finding below: the separate [OpenAI Telegram voice implementation](telegram-voice.md) now provides the owner's requested `whisper-1` path. It remains disabled pending the existing OpenAI credential; no local Whisper model installation is needed for that path.

The current model registry advertises text/image/video, not audio: <https://github.com/anomalyco/models.dev/blob/dev/providers/opencode/models/space-bunny-free.toml>. No free audio-transcription route for the existing public provider was established. Voice ingress is now recognized and returns an explicit limitation instead of disappearing silently.

The authoring Mac has `/opt/homebrew/bin/whisper-cli` 1.8.3 and FFmpeg, but its only located model is `/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin` (562 KiB). The upstream documentation confirms that `for-tests-*` files contain **no weights**: <https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md#model-files-for-testing-purposes>. It is not a usable recognizer. No model, software, account, key, or paid provider was installed or enabled.

To enable voice without API spending, the **deployment host** needs a trusted `whisper-cli` build plus actual multilingual GGML Whisper weights (for example `tiny`, approximately 75 MiB, or `base`, approximately 142 MiB), with operator-configured absolute binary/model paths. An adapter should accept bounded Telegram OGG bytes, use a private temporary directory, execute only fixed Whisper/FFmpeg arguments without a shell, omit service credentials from the subprocess environment, cap audio duration/CPU/output/wall time, delete temporary audio, and return a transcript into the ordinary request flow. Alternatively the existing provider must explicitly supply a free audio-capable model and supported transcription endpoint. Neither requirement is currently met, so no pretend transcript or paid fallback is used.

## Sandbox and mini-page proposal for parent approval

No arbitrary execution or hosting was implemented. A minimal execution facility would be a rootless isolated worker/container with a read-only runtime, only per-chat scratch files, no host mounts/credentials, network off by default, fixed supported languages, bounded wall time/CPU/memory/output, and artifact export back into the VFS. The trusted document-parsing worker is not suitable as a user-code sandbox.

Mini-pages can initially be generated static HTML/files in the existing VFS. Publishing should be a separate authorized hosting step, with opaque per-chat access, restrictive CSP, sanitized output, no host-path routes and no server-side execution. Existing authenticated file serving is not broadened into arbitrary hosting.

## Validation

Synthetic Bun integration checks cover actual compatible-provider SSE → agent → worker → private draft/group edit → durable rich final; reported usage; held delivery; photo gating/forwarding/data URLs; chat isolation; restored file and media dispatch; nested vision call caps; uncertain final send suppression; idempotent final edit retry; and persisted group recovery.

Run:

```sh
bun test ./checks/assistant-media.check.ts ./checks/assistant-documents.check.ts ./checks/assistant-files.check.ts
bun run test -- src/providers/assistant-page.test.ts src/providers/assistant-stream.test.ts src/channels/telegram-rich-delivery.test.ts src/channels/telegram-markdown-chunks.test.ts src/capabilities/documents/extract.test.ts
bun run typecheck
bun x tsc --noEmit --allowImportingTsExtensions --target ES2022 --module NodeNext --moduleResolution NodeNext --types bun-types --skipLibCheck checks/assistant-media.check.ts
bun run build
git diff --check
```

Remaining limits: voice requirements above; XLS conversion and scanned-PDF OCR; provider vision quality; enforcing process memory limits for Bun document workers; Telegram uncertain-send reconciliation; and deployment/integrator verification. No live Telegram API contract probe was performed because it would send an unsolicited message.
