# Plan: Voice Messages

## Overview
Handle Telegram `message:voice` updates by downloading the audio, transcribing it via an injectable provider (defaulting to Whisper via OpenAI/OpenRouter), and injecting the transcript as user text input. Captions are appended after the transcript. Voice bytes never touch the virtual filesystem — they are transcribed in memory and discarded. Transcription errors surface as user-visible replies.

## DoD

**When** a Telegram user sends a voice message to the bot:

1. **Success path** — voice messages enabled + valid audio:
   - Bot downloads the voice file (OGG Opus, max 1 MB)
   - Bot transcribes it via Whisper API
   - Bot shows italic-prefixed transcript (e.g. `_Transcribed: hello world_`) to the agent
   - Agent responds to the transcription as normal user input

2. **With caption** — voice + text caption:
   - Caption is appended after the transcript in the same message

3. **Oversized audio** (>1 MB):
   - Bot replies: "Voice message is too large"

4. **Transcription fails** (API error, network):
   - Bot replies: "Transcription failed: <reason>"

5. **Voice disabled** (`enableVoiceMessages: false`):
   - Bot replies: "Voice messages are not supported on this server."

**The capability is channel-agnostic** — `src/capabilities/voice/` owns the transcriber interface, Whisper implementation, constants, and helpers. The Telegram channel only wires it in and handles the `message:voice` event.

## Validation Commands
- `bun tsc --noEmit`
- `bun test src/channels/telegram.test.ts`
- `bun test src/capabilities/voice/*.test.ts` (new test file)

---

### Task 1: Define the transcription provider interface
- [x] Create `src/capabilities/voice/transcriber.ts` exporting a `Transcriber` interface: `transcribe(audioBytes: Uint8Array, mimeType: string): Promise<string>`
- [x] Export a `NoOpTranscriber` that throws `"Voice transcription not configured"` — used when no provider is wired
- [x] Add `transcriber.test.ts` covering: `NoOpTranscriber` throws, interface contract

### Task 2: Implement Whisper-based transcription provider
- [ ] Create `src/capabilities/voice/whisper_transcriber.ts` with a `WhisperTranscriber` class implementing `Transcriber`
- [ ] Constructor accepts `{ apiKey, baseUrl?, modelName? }` — mirror the model chooser pattern for consistency
- [ ] `transcribe` makes an HTTP request to the configured endpoint (OpenAI-compatible), sends audio as multipart/form-data, returns the `text` field from the response
- [ ] Handle HTTP errors gracefully; map to `"Transcription request failed: <message>"`
- [ ] Add `whisper_transcriber.test.ts` with mocked fetch covering: success, API error, network error

### Task 3: Add voice capability helpers and constants
- [ ] Create `src/capabilities/voice/constants.ts` with `VOICE_MAX_BYTES = 1_048_576` (1 MB hard cap) and `VOICE_MIME_TYPE = "audio/ogg"`
- [ ] Create `src/capabilities/voice/content.ts` with `buildVoiceContent(text, caption?)` — returns italic-prefixed transcript with optional caption appended, e.g. `"_Transcribed: ..._\n\n<caption>"`
- [ ] Create `src/capabilities/voice/fetch.ts` with `fetchVoiceBytes(file, botToken)` — reuse the same download URL pattern as photo, since voice files use the same Telegram file API

### Task 4: Wire transcriber into telegram channel
- [ ] Add `transcriber?: Transcriber` field to `ChannelRunOptions` in `src/channels/types.ts`
- [ ] In `telegramChannel.run()`, construct a `WhisperTranscriber` (or `NoOpTranscriber` if disabled) from `transcriptionProvider` config, and pass it via `ChannelRunOptions`
- [ ] In `ensureTelegramSession`, receive `transcriber` from options and attach to the session
- [ ] Add `transcriber: Transcriber` field to `TelegramAgentSession`

### Task 5: Add `message:voice` handler in telegram.ts
- [ ] Add `bot.on("message:voice", ...)` handler mirroring `message:photo` structure
- [ ] On entry: check caller permission, get or create session
- [ ] Check `session.transcriber` — if `NoOpTranscriber`, reply with `"Voice messages are not supported on this server."` and return
- [ ] Check audio file size via `ctx.message.voice` properties (`file_size` if available) — reject with `"Voice message is too large"` if exceeds `VOICE_MAX_BYTES`
- [ ] Download the voice file via `fetchVoiceBytes(file, botToken)` from the voice capability
- [ ] Call `transcriber.transcribe(downloaded.data, VOICE_MIME_TYPE)`
- [ ] Build text content with `buildVoiceContent(transcript, caption)`
- [ ] Queue via `handleTelegramQueuedTurn` with the text content (empty commandText)
- [ ] On transcription error: catch, reply `"Transcription failed: <message>"`
- [ ] On download error: reply `"Failed to download voice message: <message>"`

### Task 6: Add config flags and defaults
- [ ] Add `enableVoiceMessages: boolean` (default `true`) and `transcriptionProvider: "openai" | "openrouter"` to `AppConfig` in `src/config.ts`
- [ ] Wire `transcriptionProvider` to construct the appropriate `Transcriber` in `telegramChannel.run()`
- [ ] Follow the existing `.env` persistence pattern for the new flags
- [ ] Add tests covering flag-on and flag-off behavior

### Task 7: Add telegram channel tests for voice messages
- [ ] Add `message:voice` test cases to `src/channels/telegram.test.ts`
- [ ] Cover: successful transcription flow, oversized audio rejection, transcription error surfacing, download error surfacing, no-transcriber configured reply, caption appending
- [ ] Mock the transcriber and fetchTelegramFileBytes in tests

### Task 8: Docs and cleanup
- [ ] Update `src/channels/README.md` to document voice message support, limits, and configuration
- [ ] Add `src/capabilities/voice/README.md` describing the capability structure and how to add a new transcription provider
- [ ] Add a short note to `CLAUDE.md` pointing at the new docs so future contributors know voice support exists
