# Temporary native voice source handoff

This directory transports two ordered source patches for later integration. Application files on this branch are unchanged from published baseline `dd9faa9e17d9b8b783c52c6af182f5bcc28dc476` (`restoration/2026-10-01`), derived from source snapshot `5a0e39c1474943110728afbfa6a0174dfb123de5`. No local development history or commit author/mail headers are imported. The source license and upstream notices remain unchanged.

Apply to an isolated baseline checkout in this order:

```sh
git apply handoff/temporary-voice/0001-voice.patch
git apply handoff/temporary-voice/0002-voice-budget.patch
```

1. Source commit `7a7b6716bd89cb147c1b5eb1eb4ef6bd5c4cb65e`: native Telegram voice intake, bounded decoding and OpenAI Whisper transport, attribution, cancellation, restart-safe spend ledger and tests.
2. Source commit `d604c3e2fedcb01b4582c0e87fd20549bce3258f`: explicit synthetic guard for a zero shared service budget, strict checking coverage and budget documentation. Its original parent belongs to the integrator history; only these three file changes are transported.

Publication excludes the environment template, removes operational inventory and private production audit notes, and points configuration documentation to `src/config/assistant-voice-config.ts`. Implementation and synthetic checks are preserved. `MANIFEST.json` records exact commits, hashes and affected paths. No environment values, credentials, private audio, transcripts, databases, logs or workflow files are included.

Both final patches applied in order without conflicts to the published baseline, yielding the exact tree used for verification. Full TypeScript typecheck, strict restoration-check typecheck and active Bun entrypoint build passed. All 128 offline tests passed (746 assertions), including 28 voice tests and 100 existing state/scheduler/delivery/files/media/analytics checks. The decoder tests generated synthetic tones locally; provider and Telegram HTTP were mocked. No actual audio upload, paid API call, live bot message, activation or service change occurred.

Voice remains disabled by default and requires private operator configuration. A shared monthly budget of zero also blocks paid transcription before download; the separate voice cap does not override it. This source handoff does not configure a key or change either deployed spending ceiling. Integrator owns runtime configuration and activation.

Research/browser handoff lives on its separate branch; browser worker work in progress is excluded. Later integrations may need merging around ingress, application shutdown and transport changes. Preserve existing delivery holds, document dispatch and delivery reconciliation. Commit the integrated result separately; remove this temporary transport directory after use if desired.
