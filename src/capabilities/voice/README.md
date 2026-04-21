# Voice Capability

Channel-agnostic helpers for voice-message transcription live here.

Files:

- `transcriber.ts` defines the `Transcriber` interface and `NoOpTranscriber`
- `whisper_transcriber.ts` provides the OpenAI Audio Transcriptions implementation
- `openrouter_transcriber.ts` provides the OpenRouter chat-completions audio-input implementation
- `constants.ts` defines the hard Telegram voice constraints used by callers
- `content.ts` formats transcript text as normal user input
- `fetch.ts` downloads Telegram-hosted voice bytes without touching the virtual filesystem

Current Telegram behavior:

- voice audio is downloaded into memory and discarded after transcription
- the Telegram channel sends `audio/ogg` bytes to the configured transcriber
- transcripts are injected back into the normal text-turn flow as `_Transcribed: ..._`
- Telegram control handling keeps using the raw transcript so approvals and commands behave like text turns
- caption text is appended after the transcript when present

Configuration:

- `ENABLE_VOICE_MESSAGES=false` disables voice handling and forces the channel to use `NoOpTranscriber`
- `TRANSCRIPTION_PROVIDER=openai|openrouter` selects the provider wiring in `src/channels/telegram.ts`
- `openai` uses `/audio/transcriptions` with `whisper-1`
- `openrouter` uses `/chat/completions` audio input with the default `openai/whisper-1` model
- `TRANSCRIPTION_API_KEY` provides a dedicated OpenAI-compatible credential when transcription cannot reuse `AI_API_KEY`
- `TRANSCRIPTION_BASE_URL` overrides the provider endpoint used for transcription
- if `TRANSCRIPTION_PROVIDER` is unset, the app defaults to `openrouter` when `AI_TYPE=openrouter`, otherwise `openai`

How to add a new transcription provider:

1. Create a new implementation of `Transcriber`.
2. Keep the API in-memory: accept `Uint8Array` audio bytes plus a MIME type and return transcript text.
3. Normalize provider errors into clear `Error` messages because Telegram surfaces them directly to users.
4. Add focused tests under `src/capabilities/voice/`.
5. Wire the new provider into `createTelegramTranscriber()` in `src/channels/telegram.ts`.

Validation:

```bash
bun tsc --noEmit
bun test src/channels/telegram.test.ts
bun test src/capabilities/voice/*.test.ts
```
