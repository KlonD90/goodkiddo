# Tasks: Telegram Voice Message Support

> Feature plan: [feature-voice-messages.md](feature-voice-messages.md)

## Task list

- [ ] **Add transcription provider interface** — define `TranscriptionProvider` type and a Whisper-over-HTTP implementation
  - **Files:** `src/model/transcription.ts` (new)
  - **Context:** Follow the pattern in `src/model/` — export a factory function that reads config and returns a typed provider object. The interface needs one method: `transcribe(audio: Uint8Array, mimeType: string): Promise<string>`. Implement it against the OpenAI-compatible `/v1/audio/transcriptions` endpoint (used by OpenRouter and OpenAI).
  - **Done when:** `src/model/transcription.ts` exports `createTranscriptionProvider` and the implementation compiles without type errors (`bun tsc --noEmit`).

- [ ] **Wire transcription config into `config.ts`** — add optional `TRANSCRIPTION_API_URL` and `TRANSCRIPTION_MODEL` env vars
  - **Files:** `src/config.ts`, `src/env.d.ts`
  - **Context:** `config.ts` already resolves model/API keys from env. Add two optional fields (`transcriptionApiUrl`, `transcriptionModel`) that fall back to the main OpenAI-compatible URL and `whisper-1` respectively. Update `env.d.ts` with the two new `process.env` declarations.
  - **Done when:** `AppConfig` type includes the two new optional fields; `bun tsc --noEmit` passes.

- [ ] **Download and transcribe voice in the Telegram channel** — handle `message:voice` updates
  - **Files:** `src/channels/telegram.ts`
  - **Context:** The existing photo handler (search for `message:photo`) downloads the file via `bot.api.getFile()` and passes bytes to the model. Mirror that pattern for `message:voice`. Download the OGG bytes, call `transcriptionProvider.transcribe()`, prepend the transcript as italic text (`_Transcript: ..._`) before the caption if present, then continue with the normal agent turn. Reject files over 1 MB with a user-visible error reply.
  - **Done when:** A new `bot.on("message:voice", ...)` handler exists in `telegram.ts`; it compiles; photo handling is unchanged.

- [ ] **Unit-test the voice handler** — cover happy path, oversize file, and transcription failure
  - **Files:** `src/channels/telegram.test.ts`
  - **Context:** Existing tests mock `bot` and agent calls. Add three test cases: (1) valid voice message produces the transcript-prefixed user text and calls the agent, (2) voice file over 1 MB returns an error reply without calling the agent, (3) transcription provider throws → error reply, agent not called. Mock `createTranscriptionProvider` the same way photo tests mock the model.
  - **Done when:** `bun test src/channels/telegram.test.ts` passes with all three new cases green.

- [ ] **Document voice message support in the channels README** — update the Telegram how-to section
  - **Files:** `src/channels/README.md`
  - **Context:** The README has a "Photo handling" subsection under "Telegram How-To". Add a parallel "Voice handling" subsection: how voice files are received, the 1 MB cap, transcript prefix behaviour, and what happens on transcription failure.
  - **Done when:** The README has a "Voice handling" subsection with the four bullet points above.
