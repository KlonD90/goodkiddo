# Telegram voice restoration

## Current checkpoint and activation boundary

This source checkpoint restores native Telegram voice intake through the fixed OpenAI Whisper endpoint. Voice is disabled by default and requires a privately configured `TRANSCRIPTION_API_KEY` and `ENABLE_VOICE_MESSAGES=true`. It never falls back to another key, provider or model.

The configuration enforces at most $5 per calendar month in Asia/Tbilisi. The FFmpeg binary path is explicit operator configuration. Integrating this source does not configure credentials, start services, activate transcription or make paid API requests.

## Data path and limits

`AssistantIngress` applies the usual bot/channel/private/mention/reply gate before any download. An addressed native Telegram voice is accepted only from the current author; forwarded voice is rejected rather than executed as somebody else's instruction. Audio attachments/documents and voice-output/TTS are outside this change.

`AssistantVoiceIntake` starts bounded background work, immediately allowing polling, commands, reminders and deliveries to continue. At most two voice jobs run globally and at most one per author or chat. Telegram download supports an abort signal and streaming byte limits; advertised and actual bytes cannot exceed **1 MiB**. Metadata and decoded audio cannot exceed **120 seconds**. UTC-day quotas default to five voices/author and ten/chat; regular task quota and the 100-item inbox bound also apply before upload.

FFmpeg decodes one forced Ogg audio stream using fixed arguments, no shell, no files, no network protocols, no inherited environment/credentials, one decoder thread, a 16 MiB per-allocation bound, a 10-second kill timeout and a bounded PCM stdout. It stops after the configured duration plus one second, then rejects decoded overlength. Mono 16 kHz PCM becomes a WAV with a duration measured from decoded bytes. This bounds the audio actually sent independently of Telegram duration metadata. It is not an OS-level total-memory sandbox; FFmpeg is the existing trusted operator binary.

OpenAI receives exactly `model=whisper-1`, `response_format=json` and `voice.wav` at the fixed HTTPS endpoint, with redirects forbidden and no automatic retries. No chat context, Telegram ID/name, filename or transcript prompt is supplied. Combined download/decode/upload wall time is at most 60 seconds, transcript JSON at most 64 KiB, text at most 10,000 characters. Errors expose only fixed safe messages.

The transcript enters the ordinary `InboundRequest` queue with original author/chat/topic/time and context version; speech/captions cannot invoke slash commands. LLM task quotas and tool authorization remain in force. A normal response is text. Source audio, WAV and PCM stay in memory and are not persisted. Transcript text is stored/handled like an ordinary request. `/privacy` describes OpenAI/audio and LLM/text handling. `/cancel_voice` cancels only that user's in-flight transcription in that chat; `/clear` also aborts through the existing context registry and suppresses stale completion. Shutdown aborts and awaits active work before closing SQLite.

Analytics reuses `bot_interaction` and `request_accepted`, with allowlisted `input_type=voice|text`; existing task/model/tool events follow as usual. There is no audio, transcript, file ID/name, raw Telegram ID or provider exception in PostHog. No synthetic test event was sent to real PostHog.

## Hard budget and restart behavior

The [official Whisper model page](https://developers.openai.com/api/docs/models/whisper-1) currently lists **$0.006/minute** (verified 2026-10-01). The [official transcription reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) supports Ogg and WAV; the broader [guide](https://developers.openai.com/api/docs/guides/speech-to-text) caps API uploads at 25 MB. This bot uses smaller limits. Pricing is operator configuration and cannot be set below the verified rate; changes in the upstream tariff require updating the configured reservation rate before further paid use. A computed reservation is a conservative estimate, not an exact provider invoice.

`assistant_voice_requests` is an additive table containing only receipt ID, chat/owner/topic, context version, status, timestamps, budget month and reserved/estimated USD. Before starting download, a synchronous SQLite transaction counts daily attempts and reserves the maximum call cost globally against the voice month's budget and the existing shared service monthly spend limit. The hard voice configuration refuses values above **$5**. The default 120-second call reserves **$0.012**, rounded up to whole minutes. A successful bounded result settles to decoded duration rounded up to whole minutes, so even subminute audio is charged a full minute in the local conservative ledger.

The upload-time transaction rechecks the budget and assigns the current Asia/Tbilisi month, including a decode spanning the month boundary. Duplicate Telegram update IDs cannot spend twice. SQLite transactions serialize reservations across database connections. Call failures, empty/invalid responses, timeouts, cancellation or crashes after upload retain the full reservation because billing may already have occurred. A failure known to happen before upload refunds it. Restart marks unfinished receipts interrupted, retains their reserves and sends a safe interruption reply without automatically uploading again. A user-sent retry is a new receipt subject to the same remaining budget/quotas; it never resets earlier charges. New transcriptions stop before the cap with a clear text fallback.

Conservative reservations can stop calls before all $5 is used. For example 416 unresolved 120-second calls consume $4.992; the next $0.012 reservation is rejected. Refunds/settlements never use an unknown audio duration. Receipts and spend persist across deploys in the same private assistant database; do not delete those rows/database or raise the configured cap as a retry mechanism.

## Configuration

See `src/config/assistant-voice-config.ts`: `ENABLE_VOICE_MESSAGES=false`, `TRANSCRIPTION_API_KEY`, `VOICE_MONTHLY_BUDGET_USD=5` (0–5), `VOICE_USD_PER_MINUTE=0.006` (minimum 0.006), `VOICE_MAX_SECONDS=120` (1–120), `VOICE_DAILY_PER_USER=5`, `VOICE_DAILY_PER_CHAT=10`, `VOICE_TIMEOUT_MS=60000` (at most 60000), `VOICE_FFMPEG_PATH=/usr/bin/ffmpeg` (absolute trusted path). There is no configurable provider/base URL/model or implicit chat-key reuse. `LLM_MONTHLY_BUDGET_USD` remains an additional shared spend ceiling.

A shared `LLM_MONTHLY_BUDGET_USD=0` ceiling blocks transcription before download even when a key, voice enable flag and independent voice cap are configured. For voice operation within the $5 cap, the shared ceiling must also permit that spending. Preserve any free chat provider/model and its zero input/output prices; enabling voice does not activate a paid chat fallback. Both ceilings remain enforced, including shared spend from other configured capabilities. Source integration does not change deployed budget or credential settings.

## Offline verification

`bun test ./checks/assistant-voice.check.ts` uses mocked Telegram and OpenAI HTTP, private test SQLite and locally generated tones only. It checks attribution/group gating/forwards, command isolation, enabled/key/budget gates, quotas/concurrency, streamed download bounds, owner cancellation, `/clear`, timeout, safe provider failures, refunds and ambiguous billing, duplicates/restarts, multiple DB connections, the $5 cap, Asia/Tbilisi month rollover, privacy allowlists and actual local FFmpeg decoding/overlength rejection. No recorded user audio is used.

The two FFmpeg decoder tests use an available local binary (`VOICE_TEST_FFMPEG_PATH`, otherwise `/opt/homebrew/bin/ffmpeg` on macOS and `/usr/bin/ffmpeg` on Linux). Normal mocked tests need no provider key. Run typecheck/build and the existing core, media, documents, files, scheduler and analytics regression checks before integrating. Live OpenAI authentication and actual voice delivery are outside these offline checks.

Validation completed: **27 voice tests**, **68 Bun core/media/files/documents/scheduler/analytics regression tests**, **41 focused Vitest provider/formatting/document tests**, repository typecheck, strict test-file typecheck, build and whitespace checks passed. The unchanged broad legacy Vitest suite is not a clean repository gate: the preceding analytics audit reproduced 150 baseline failures (native SQLite binding and existing Bun tests under Vitest). No broad-suite pass is claimed here.

Maintainability review: the substantial voice workflow (251 lines), provider (184 lines) and ledger (140 lines) are extracted into focused files. Existing ingress remains a command/message router (577 lines, mostly existing commands), with only lifecycle/enqueue hooks; it contains no decoder, provider HTTP or budget SQL. No scrapper, delivery reconciliation, browser worker or production checkout edits.
