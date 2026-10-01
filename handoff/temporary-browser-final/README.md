# Temporary final browser checkpoint handoff

This branch transports the final delta from source `08fce09e832d383b18d6cc8ff30b71beb0180d23` to `6356d2fab92e2d331e649727071f35b5836153a8` without importing private history. Application files on this transport branch remain identical to published full-source baseline `b8f586b9fb3180e63b290512df02760206d2d8bb` (`restoration/2026-10-01-browser-cloud`), including current quiet voice.

Apply the single patch to an isolated checkout of that baseline:

```sh
git apply handoff/temporary-browser-final/0001-browser-final.patch
```

The patch preserves all four changed source fixture/installation files byte-for-byte: trimmed public redirect URL assertion, confinement fixture stdin isolation, the real watchdog expiry fixture, and fresh-install rootful Podman defaults handling. Generic documentation replaces previous incomplete-runtime status with the final checkpoint's reported verification results. No environment file, private host evidence, deployment address, installed image identifier, credential, database, profile or workflow is transported. License and notices remain unchanged.

Source parity and patch syntax/applicability were checked. Worker and parent report the final runtime checkpoint tested and server-ready; this publication task did not rerun runtime tests or contact production. The new expiry fixture is an explicit operator action, not an automatic test or setup command. Application activation and the final release remain the integrator's separately authorized work.

`MANIFEST.json` records source commits, exact hashes and affected paths. Preserve quiet voice, current settings, shared spend reservations, document dispatch, delivery holds and recovery reconciliation during integration. Remove this temporary transport directory after use if desired.
