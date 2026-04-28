# Feature: Telegram Voice Message Support

## Summary
Users send voice messages (`.oga`/`.mp3` Telegram audio) to the bot and the bot transcribes them, treats the transcription as normal user input, and responds. This mirrors the existing photo-message flow and unlocks hands-free use of the agent on mobile.

## User cases
- A user records a voice note on Telegram instead of typing so that they can interact with the agent while on the go.
- A user sends a voice message asking the agent to create a file, so that the agent processes the request without the user needing to retype it.
- When transcription fails or the audio is too long, the user receives a clear error message rather than silence.

## Scope
**In:**
- Telegram `message:voice` updates (OGG Opus, up to ~1 min / 1 MB)
- Download the voice file from Telegram's file API
- Transcribe using the configured model's audio input, or a dedicated transcription API (e.g. Whisper via OpenAI/OpenRouter)
- Inject the transcript as the user text turn; continue with the normal agent flow
- Captions on voice messages are appended after the transcript

**Out:**
- `message:audio` (music files) — not handled in this iteration
- Voice *output* (text-to-speech replies)
- Long-form recordings (>1 min / >1 MB hard cap)
- Transcription confidence scores or speaker diarisation

## Design notes
- Telegram voices arrive as `message.voice` with a `file_id`; use `bot.api.getFile()` + download URL to retrieve bytes.
- The transcription provider should be injectable (same pattern as `src/model/`) so we can swap Whisper for a local model later.
- Transcription errors must surface as a user-visible reply, not a silent drop — same contract as photo handling failures.
- Voice file bytes never touch the virtual filesystem; they are transcribed in memory and discarded.
- Open question: should the transcript be shown to the user before the agent responds, or silently consumed? Default to showing it (inline italic prefix) for transparency.

## Related
- [Execution plan: Telegram Voice Messages](../plans/telegram-voice-messages.md)
