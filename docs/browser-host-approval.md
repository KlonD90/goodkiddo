# Browser host inventory and specific approval scope

Read-only inventory completed 2026-10-01 over the existing trusted SSH route with
strict host-key checking. No credentials, service environment, bot data, browser
profiles or logs were read. No production changes were made.

Host: Ubuntu 24.04.3 LTS, Linux 6.8, x86_64, eight CPUs; 31.2 GiB total RAM and
21.1 GiB available at inspection. Docker 29.4.1 and Node 22.22.2 are installed;
GoodKiddo's private Bun executable exists. Cgroup v2, unprivileged user namespaces,
iptables/nftables and /dev/kvm are present. Availability does not verify that a
rootless runtime or its resource controls are configured.

Absent on PATH: agent-browser, Chromium/Chrome, Podman, runsc/gVisor and bubblewrap.
FFmpeg is present; whisper-cli is absent (voice remains a separate pending decision).
Current official agent-browser main metadata declares Node >=24 for the package
wrapper. Do not upgrade the host's shared Node or assume its current Node suffices.
Select a reviewed pinned release; place its required runtime inside the worker.

## Proposed user approval text

> May we install a pinned official agent-browser/Chromium runtime in a separate
> nonroot browser worker on the existing server, plus the rootless container/
> gVisor support it needs, and enable restricted public HTTP/HTTPS access for
> read-only research? Start with one worker (hard maximum two), one CPU, 1 GiB RAM,
> 64 processes and 128 MiB temporary storage per worker; 60 seconds per job,
> 15 seconds per command and bounded output. The worker gets fresh per-chat/job
> browser state, no bot credentials, host files or existing profiles, and a
> checked egress path blocking private addresses, DNS rebinding and direct
> sockets/UDP. It can read pages, follow links and scroll; forms, messages,
> purchases, login and arbitrary commands remain unavailable. This uses the
> existing server and configured model allowance, with no new paid provider,
> account, subscription or increase to the bot's spending limits.

This approves a specific installation/worker boundary, not arbitrary shell
execution by the bot. No public CDP endpoint or external browser port is needed.
Use an authenticated local Unix-socket transport. Install new dependencies in
the dedicated worker/runtime; preserve shared host Node and other services.
Firewall work is limited to the new worker's network namespace and scoped
egress rules; do not change unrelated host/service policies. Start with one
worker on the host's existing capacity; verify resource enforcement before
allowing a second. Installed Docker alone is not a verified confinement boundary.

Provision a dedicated nonroot worker identity and rootless runtime with cgroup v2
CPU/memory/PID controls, a pinned read-only browser image and tmpfs-only job state.
If gVisor is selected, install its official pinned runsc/runtime integration and
verify Chrome compatibility while preserving Chrome's own sandbox. No privileged
container, Docker socket mount, host network mode, host bot DB/environment/profile
mounts or --no-sandbox workaround. If this combination cannot be verified, stop
and return the specific incompatibility before changing privilege or scope.

The browser must have no direct egress: permit only its scoped egress proxy;
the proxy resolves and pins validated public IPs per connection. In-browser
interception enforces GET/HEAD and exact approved source/CDN domains before page
requests. Redirects, frames, subresources and workers receive the same checks;
WebSocket/WebRTC/UDP and any bypass fail closed. HTTPS tunnels alone do not enforce
HTTP methods. Synthetic adversarial pages must verify these controls and child
cleanup before the runtime's browser injection is enabled.

## Registration ready independently of installation

The local follow-up registers the HTTP/VFS/document research adapter and clarifies
the main prompt's supplied-URL behavior. It does not register or activate rendered
browser tools, add a service, start a live job, enable search without a configured
key, or increase model budgets. Shared-call exhaustion returns bounded partial
status so the parent can use its reserved final call. Actual financial/daily limits
continue to stop calls. This follow-up must not block the already-tested main release.

Sources: [official installation](https://agent-browser.dev/installation),
[package runtime metadata](https://github.com/vercel-labs/agent-browser/blob/main/package.json),
[security and egress limitations](https://agent-browser.dev/security),
[gVisor rootless mode](https://gvisor.dev/docs/user_guide/rootless/),
[Docker rootless requirements](https://docs.docker.com/engine/security/rootless/).
