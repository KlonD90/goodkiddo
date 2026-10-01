# GoodKiddo restoration source

This complete source branch preserves quiet voice, chat-scoped files and temporary links, durable memory/TODOs/scheduled prompts, delivery recovery, analytics, bounded research and the isolated read-only browser. The standalone sanitized baseline is `b8f586b9fb3180e63b290512df02760206d2d8bb`; the verified browser follow-up originates from `6356d2fab92e2d331e649727071f35b5836153a8`. No private development history is imported.

The integrated release is `0b9d5406a8c129ddf1b258d52ef074b5f0075321`. Building this published source produces the same active bot bundle as that release: SHA-256 `692b28a64afa747816dd392b5eb33414b6aae05afac66afc45a703354acdffdc`. Existing sanitization of legacy documentation and fixtures is retained. `SOURCE_SNAPSHOT.json` records tracked relative paths, file modes, provenance and SHA-256 hashes; its own hash is excluded to avoid self-reference. The existing license and upstream notices remain unchanged.

Verification passed: 141 Bun tests with 879 assertions, 86 Vitest tests, four focused TypeScript checks and the active build. Installed-worker verification passed public rendering/navigation, public redirects, private redirects/IP denial, fresh job storage, native sandbox and resource confinement, complete socket cleanup and observed 60-second expiry. A harmless public-page check passed the real configured free model → research → browser → final-answer chain, including cleanup, within six model calls and at $0. It sent no Telegram messages, emitted no analytics events and used a temporary synthetic database.

Source defaults keep browsing disabled. The deployed GoodKiddo release explicitly enables the verified fixed Unix socket. Credentials, host configuration and persistent state remain external to this source. This tree contains no environment files, databases, logs, conversations, audio, transcripts, browser profiles, recovery archives, private deployment addresses or operator audit notes.

See `CLOUD_HANDOFF.md` for runtime boundaries and preservation requirements.
