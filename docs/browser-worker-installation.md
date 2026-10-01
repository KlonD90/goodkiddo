# Isolated read-only browser worker

This follow-up replaces the inactive worker boundary described in
`browser-research-restoration.md`. It adds a real rootless Chromium/agent-browser
implementation and explicit assistant injection. Default bot bootstrap does not
construct this runtime. It changes no Telegram ingress, voice, final delivery,
file dispatch, or delivery holds.

## Source checkpoint and remaining verification

The source implements a rootless Chromium/agent-browser worker and optional assistant integration. Publication does not install or activate the worker. Keep the browser socket setting unset until an operator completes runtime verification.

Remaining checks include the revised public/private top-level redirect fixture, fresh-job storage isolation, complete broker-socket/public-link/cleanup flow, and actual 60-second expiry. Local unit and mocked integration checks do not establish that those live runtime gates passed. Installation and deployment require separate authorization for the destination; this source handoff does not grant it.

## Boundary

The assistant exposes only snapshot, public href navigation, and scroll inside
its bounded research subagent. `BrowserResearchRuntime` keeps one shared frontend
slot, creates fresh opaque jobs owned by the current chat/task, and contacts its
fixed Unix socket only when a browser tool is actually executed. The broker
additionally admits one active job across all connections.

Every container has 1 CPU, 1 GiB RAM with no extra swap, 128 PIDs, private IPC,
64 MiB shared memory, and 128 MiB ephemeral `/tmp`. It runs as UID 1000, without
capabilities, new privileges, host mounts, devices, published ports, or direct
network access. The service also caps aggregate CPU/RAM and kills its complete
cgroup on stop. Three independent 60-second watchdogs cover broker, controller,
and Podman; commands have a shared 15-second deadline. The 60-second expiry has
not yet been tested by waiting out a live job.

Browser resource requests cross a bounded stdin/stdout bridge. The host allows
only GET/HEAD, checks every destination against public-IP policy, checks all DNS
answers on each request, and pins the actual socket to a validated address while
preserving TLS hostname verification. Browser cookies, authorization, bodies,
and arbitrary headers are never forwarded. The bridge limits each resource to
2 MiB, each job to 40 requests/16 MiB/eight exact public hostnames, and concurrent
requests to four. `HEAD` currently performs a safe host GET and omits the body in
the browser response. Compressed responses fail closed if a server ignores the
host's identity encoding request.

CDP Fetch interception pauses each main-page request and redirect hop. Images,
fonts, media, non-GET/HEAD methods, service workers, WebSockets, downloads, and
popups are blocked. Unintercepted cross-origin frames/workers have no direct
network route and fail closed; some sites will render incompletely. Local CDP is
inside the fresh container only. No external CDP port is exposed. JavaScript runs
only inside this browser boundary; this does not provide arbitrary code execution.

The pinned vendor action policy uses raw actions `launch`, `navigate`, `snapshot`,
`url`, `gettext`, `getattribute`, `scroll`. Internal `launch` attaches to the fixed
already-sandboxed CDP browser; it is never a caller command. No fill, click, eval,
forms, login, state import, uploads, or shell arguments are accepted. Page text is
untrusted evidence, bounded to 20k characters per result and 60k per job. Requests
carry only fixed read commands and public URLs; bot environment, history,
attachments, and provider credentials are not forwarded.

Cancellation sends a close request through the original connection with a fresh
cleanup deadline. The broker stops the launcher before forced removal, waits for
confirmed cleanup, and only then releases capacity. An unconfirmed cleanup keeps
the slot quarantined. Worker errors returned to the assistant are generic;
bounded diagnostics are available only to explicit operator fixtures.

## Runtime and installation

Vendor pins and hashes are in `ops/browser-worker/vendor-pins.json`. The image is
Playwright 1.63.0 on Noble, pinned by digest. The standalone dependency lock pins
Playwright/core 1.63.0. Prepare it with installation scripts disabled; do not run
the bot's shared install or upgrade shared host Node. The official agent-browser
0.38.1 native binary bypasses its Node >=24 package wrapper. `install-native.py`
verifies the published archive SHA512 and extracts exactly one native executable;
it never runs package hooks or extracts arbitrary archive paths.

`prepare-seccomp.py` verifies the unmodified official Playwright seccomp profile
and derives a profile with one additional `chroot` allow rule. Chromium needs
that syscall to remove filesystem access inside its own user namespace. Container
capabilities remain empty and the rest of the deny-by-default profile is retained.
The broker's standard rootless uidmap helpers require `NoNewPrivileges=no` on
the dedicated broker service; every child container has no-new-privileges enabled.
No host user-namespace, AppArmor, firewall, Docker, or global security setting was
changed. gVisor and arbitrary-code sandbox installation are separate deferred work.

The prerequisite script installs pinned runtime packages and creates a dedicated nologin identity with disjoint subordinate IDs. On a fresh installation it disables unused rootful Podman defaults. Establish ownership and absence of users before changing any preexisting service.

After destination authorization is resolved, the operator should:

1. Compile the broker and explicit checks using `bun build --target=node`.
   Transfer only those bundles, the dedicated service/socket units, and the
   fixed confinement launcher. Never transfer `.env`, bot data, keys, profiles,
   whole checkouts, or host dependency trees.
2. Install the reviewed broker at `/opt/goodkiddo-browser/broker.js`, substitute
   the tested image tag for `IMAGE_TAG` in the service template, reload systemd,
   and restart only `goodkiddo-browser.service`. The local socket uses mode 0660,
   worker ownership, and the existing `goodkiddo` group. No HTTP listener is added.
3. Run the confinement and adversarial fixtures as the dedicated worker inside
   its delegated service cgroup. The root-only fixed confinement launcher moves
   its own PID there before dropping privileges; it grants no new cgroup access.
   Run `checks/browser-host.verify.ts` through the socket as the existing bot
   identity. Inputs are synthetic or public documentation pages only.
4. Confirm public rendering, a public top-level redirect, private redirect denial,
   fresh browser storage, public href navigation, cleanup ACK, and no remaining
   `goodkiddo-browser-*` containers. Test 60-second expiry before claiming it was
   verified. Resolve only newly installed rootful Podman defaults independently
   of shared Docker or bot services.

## Integrator hook after verification

This commit modifies only optional parameter plumbing in `agent.ts`, `tools.ts`,
and `worker.ts`. The integrator owns app/config changes:

```ts
import { BrowserResearchRuntime } from '../assistant/browser-runtime.js';

const browser = config.browserSocket
  ? new BrowserResearchRuntime(config.browserSocket)
  : undefined;
const worker = new AssistantWorker(store, config, analytics, llm, api, browser);
```

An optional explicitly enabled `ASSISTANT_BROWSER_SOCKET` must be validated as
exactly `/run/goodkiddo-browser/worker.sock`; unset means disabled. Do not contact
the worker on startup or advertise browsing before verification. The existing
research adapter keeps the configured model, current task/chat, VFS quotas,
global call/spend/daily allowance, reserved final call, and no child streaming.
It does not add a provider, paid service, account, key, or autonomous communications.

## Focused validation

45 Vitest tests cover browser policy/job/research and the new broker, egress,
command schema, vendor action policy, cancellation, concurrency, and cleanup.
Nine Bun research checks pass with 79 assertions, including registered parent to
child to final flow, shared budget, zero spend, ownership, and reserved final call.
Focused TypeScript checking and the existing main bot build pass. No real model,
private Telegram input, or Telegram message was used.

```sh
bunx --no-install vitest run src/capabilities/browser src/capabilities/research src/browser-worker/worker.test.ts
bun test ./checks/assistant-research.check.ts
```

The socket fixtures require local Unix socket permission on macOS. Remote fixture
entrypoints under `checks/` are explicit operator actions, never bot commands or
automatic test-suite setup.

Sources: [Playwright container guidance](https://playwright.dev/docs/docker),
[pinned seccomp profile](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json),
[agent-browser security](https://agent-browser.dev/security),
[pinned native command dispatch](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/commands.rs),
[Chromium namespace sandbox](https://github.com/chromium/chromium/blob/main/sandbox/linux/services/credentials.cc).
