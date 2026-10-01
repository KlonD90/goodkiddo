# GoodKiddo browser integration checkpoint

The restored assistant keeps the current voice, files, core tools, scheduler,
delivery snapshots and budget. The worker is an optional dependency passed from
the app through the existing worker and parent agent to the bounded research
subagent. It receives the current chat/task scope and cancellation signal.

`ASSISTANT_BROWSER_SOCKET` is unset by default. If explicitly configured, it must
equal `/run/goodkiddo-browser/worker.sock`; every other path, relative socket and
HTTP destination is rejected. Constructing the runtime does not connect to a
socket or launch a browser. Only an actual browser read tool opens a job. The
research adapter closes it before the parent's final completion, keeps one
shared slot, reserves the final model call and records zero-cost provider calls
under the existing shared accounting. This adds no credential or spending cap.

Synthetic integration tests exercise registered parent → research → browser →
final, current chat/task propagation, read-only child tools, cleanup before final,
normal VFS note storage and preserved shared model-call counting. They do not
contact production, providers, Telegram or Chromium.

## Remaining runtime gates

Keep the socket setting unset until the operator verifies top-level public/private redirects, fresh job storage, the complete socket and public-link flow, cleanup acknowledgement and 60-second expiry. Source publication does not perform installation, deploy code, change runtime settings, activate browsing or authorize any remote operation.

Preserve the current quiet voice behavior, file dispatch, delivery holds, recovery snapshots and shared spend ledger when completing this integration. Credentials and runtime data are private operator configuration and are not part of the public source.

Rootful Podman defaults are separate from this rootless worker. Any future cleanup must establish that each unit is unused and owned by the installation being changed; shared services and unrelated host access settings are outside this source checkpoint.
