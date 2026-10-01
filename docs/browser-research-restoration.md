> Historical module checkpoint: the optional worker implementation and integration added later are documented in `browser-worker-installation.md` and `browser-integration.md`. Browser activation still depends on the runtime verification gates there.

# Browser and research restoration checkpoint

The cafebef base checkpoint contained inactive browser components and an unregistered
research tool. Its follow-up now registers HTTP/VFS/document research and clarifies
supplied-URL behavior. Browser components remain inactive and unconnected.
Nothing installs software, launches Chrome, changes firewall/network policy, reads
host credentials, or deploys a service. Delivery reconciliation belongs to the integrator.

## Actual regression

The old `top-fedder` tree implements:

- `bot/src/capabilities/research/agent.ts`: short-lived LangGraph agent, isolated
  MemorySaver, browser tools, SearXNG, read-only workspace and tabular tools.
- `research/tool.ts`: quick/standard/deep recursion limits 15/40/80, compact synthesis,
  source notes stored as `research/<id>.md`.
- `bot/src/tools/browser_tools.ts`: agent-browser CLI snapshots plus click/fill/
  scroll/wait/back; caller/job session namespaces. `browser_session_manager.ts`
  defaults to eight sessions and five-minute idle expiration.
- `tools/factory.ts`: creates research, normally removes browser tools from the
  parent, and points SearXNG to `http://127.0.0.1:8080` by default.
- `Dockerfile.dev` / Ansible install agent-browser without a pinned version and
  configure Chromium/Chrome. The research browser wrapper directly spawns the CLI;
  the separate execute-workspace manifest does not guard these calls.

The new `GoodKiddo` legacy orchestrator displays subagent progress but is not the
active assistant. Active `src/assistant/agent.ts` has no research loop, browser
tools or SearXNG adapter. Restoration commits cdf3fa4/e70267b add public `read_url`:
HTTP extraction, three reads per context, 2 MiB/page, 20k characters, 15 seconds,
three redirects, private-IP rejection and validated socket address pinning. It
does not execute page JavaScript or produce rendered accessibility snapshots.
Brave discovery remains unavailable without its configured key; this must not
be described as an inability to read a supplied public URL. A refusal alone
does not prove which deployed prompt/tool version is responsible: inspect the
integrator's deployed tool names and a synthetic read_url tool-call trace.

The old direct CLI wrapper inherits process environment, permits arbitrary URL
schemes and JavaScript wait expressions, and collects unbounded stdout/stderr.
Its session namespaces and timer alone are insufficient for shared bot isolation.

## New minimal components

`src/capabilities/research/agent.ts` provides a fresh in-memory context, one bounded
subagent (2/3/4 model calls), at most four tools per completion, eight reads,
60 seconds, 24k accumulated tool-output characters and 8k summary characters.
Only explicitly registered reads are dispatched. No recursion, execution,
writes, reminders, sending, or communications are exposed. Source notes accept
only exact URLs/virtual paths observed in successful read results. Notes are
untrusted evidence, including their summaries.

`src/assistant/research-tools.ts` uses the SAME configured model, task ID, monthly
spend reservation, global task-call counter and current-chat VFS. No separate
provider/key is introduced. One model call remains reserved for the outer answer.
Only the supplied brief reaches the subagent; parent history, other chat files,
images and secrets are not added. Controlled orchestration stores bounded immutable
JSON notes under `/research/<task-hash>.json`, with existing quotas, including on
partial/error exit. Heavy research uses the existing dailyResearch accounting.
One research invocation per ToolContext is allowed. The research subagent may
read three HTTP pages independently of the parent's three-read context allowance.

`src/capabilities/browser/` provides:

- A per-connection network policy with exact domains (maximum eight), GET/HEAD
  only, public DNS/IP validation and a returned address for socket pinning.
- Opaque unique job/session IDs and immutable current chat/task ownership.
  A runtime-shared BrowserSlots instance caps concurrency at two.
- Fixed command plans for snapshots, following an href (without clicking), and
  scrolling. No user-defined CLI arguments, CSS, JavaScript, shell, auth/state,
  uploads, downloads, plugins, forms, purchase or communication tools.
- 60-second jobs, 15-second commands, 12 commands, 20k characters per output,
  60k total output and 128 KiB transport output per command. The worker MUST enforce
  byte limits incrementally, not after buffering arbitrary output.
- Cancellation and five-second cleanup acknowledgment. A failed cleanup retains
  its concurrency slot rather than spawning more unconfirmed browser children.

There is deliberately NO default BrowserWorker implementation. Tests inject a
synthetic worker. Passing the app's initial URL check is not browser-wide SSRF
protection: a real worker must enforce the policy for every subresource, redirect,
frame, worker and connection, including DNS rebinding. It must reject POSTs and
block sockets, WebRTC/UDP and direct egress below the browser process. HTTPS
CONNECT alone cannot enforce request methods; browser request interception plus
validated/pinned proxy connections and OS containment are required. Some SPAs
will not work under GET/HEAD-only access; report that limitation truthfully.

## Integrator wiring

Steps 1 and 2 below are implemented by the follow-up commit. The cafebef base added
only isolated modules; the follow-up touches `tools.ts` and `prompt.ts`. Apply them
as a separate release follow-up, preserving all existing integrator changes.

1. Import `researchToolDefinitions` and `executeResearchTool` into
   `src/assistant/tools.ts`; concatenate the definition and dispatch name
   `research` before the main switch using `executeResearchTool(input, ctx)`.
   Default operation has HTTP/VFS/document reads only. It does not need a browser
   installation or a search key. Ensure the ordinary run already has a metered
   parent model call; all nested usage remains on that run.
2. Clarify the main prompt: supplied public URLs should be tried with `read_url`
   even without search. `research` is a read-only helper using the same model,
   not the old mandatory Owner/Reviewer/Arbiter product. Advertise rendered
   browsing only when the approved worker is actually connected. Never claim
   a read/search succeeded after a tool error.
3. Optional configured search: inject a ResearchTool named `search_web` whose
   execute callback delegates through the existing `executeTool('search_web',
JSON.stringify(input), ctx)` so its allowance and spending checks remain.
   Restoring old SearXNG requires a separately approved pinned service/adapter;
   do not assume the old localhost service exists on the migration host.
4. After browser approval and enforcement verification, allocate a fresh
   ReadOnlyBrowserJob for the current chat/task and pass `{ browser: job }`.
   Its BrowserNetworkPolicy receives only approved source/CDN domains. The
   subagent cannot expand that list. Other domains are explicitly unavailable.
   The wrapper closes owned browser jobs even when validation/budget fails;
   foreign jobs are rejected without operating on them.
5. Factory objects must be synchronous handles; start remote/isolated work inside
   `run`, where cancel/dispose can address it. No async factory whose late result
   could orphan an untracked Chrome process. Confirm cleanup after worker crashes
   before releasing quarantined slots.

## Concrete approval and activation requirements

`ops/browser-restoration.disabled.json` is a planning template, not a configuration
loaded by this application. It remains disabled and has no transport.

Read-only Mac inventory found Bun 1.3.11 and no agent-browser executable on PATH.
No browser profile or credential directory was inspected. Deployment-host package
availability is unknown; parent/integrator owns that inventory and release.

Needed approval: install a pinned reviewed agent-browser release, Chromium/Chrome
and necessary Linux libraries if absent; provision a separate nonroot worker
with fresh state directories and no bot secrets, VFS/database mount, host browser
profiles, extensions or plugins; enable restricted public egress through a checked
proxy plus firewall/network namespace; wire its local authenticated transport.
No public browser/CDP port, new cloud account/key or paid browser provider is needed.
Use the deployment server rather than making the Mac a persistent dependency.

Current official main package metadata says version 0.38.1 and Node >=24 for its
package wrapper. This is not a verification of an installed/released artifact:
pin and verify a published version and its actual flags/runtime before approval.
The old global unpinned install may lack current controls. The official installation
guide supports an existing system Chromium executable, avoiding a second browser
download when a suitable runtime is already installed. No install is performed here.

Use separate rootless gVisor containment if approved and compatible, or an approved
equivalent VM boundary. Recommended initial caps are 1 CPU, 1 GiB RAM, 64 PIDs and
128 MiB ephemeral storage per worker; these are proposed limits, not vendor
requirements. Preserve Chromium's sandbox; fail closed if confinement cannot be
verified. Do not solve launch errors by exposing host credentials or granting
privilege/`--no-sandbox`. Verify real cleanup, CDN loading, method blocking, private
redirects/rebinding, frame/worker/socket containment and child-process termination
with synthetic pages before activation. No real Telegram or private inputs.

Read-only browsing is the only implemented contract. External submissions,
communications, authenticated activity or other actions need task-specific user
authorization and a separately reviewed adapter. Click/fill/eval remain unsupported.

## Sources and checks

- [Official agent-browser security](https://agent-browser.dev/security): controls
  are opt-in; domain allowlisting is not an OS firewall. Combine exact allowlists,
  restrictive action policy, content boundaries and output caps with worker egress.
- [Official installation](https://agent-browser.dev/installation),
  [sessions](https://agent-browser.dev/sessions), and
  [package metadata](https://github.com/vercel-labs/agent-browser/blob/main/package.json).
- [gVisor](https://gvisor.dev/docs/) and
  [rootless container boundary](https://docs.docker.com/engine/security/rootless/).

Synthetic checks: 37 Vitest tests cover connection checks, DNS rebinding, private
redirects/resources, strict command schemas, ownership-independent opaque state,
concurrency/cancel/cleanup/output, research registry/prompt injection/limits.
Nine Bun integration tests verify same-model/task budgets, zero
spend, final-call reservation, context/chat isolation, notes, owned cleanup,
registered parent-to-child-to-final dispatch, child streaming isolation and shared
optional search allowance. All model/search calls are synthetic.

Run: `bun test ./checks/assistant-research.check.ts`,
`bunx --no-install vitest run src/capabilities/browser src/capabilities/research`,
`bunx --no-install tsc -p checks/tsconfig-research.json`.

## Cloud integration validation

The two source handoff patches were applied to published restoration baseline
`dd9faa9e17d9b8b783c52c6af182f5bcc28dc476`. The combined restoration Vitest
configuration includes the browser contract, network policy and research unit
tests; the restoration check typecheck also includes the research integration
checks. Install dependencies with Bun 1.3.13 and the frozen lockfile. Run Vitest
under Node (the default package executable runtime), not by running its `.mjs`
entrypoint directly with Bun; the latter produced Zod import failures in cloud.

```sh
bun test ./checks/assistant-research.check.ts
node node_modules/vitest/vitest.mjs run --config checks/vitest-restoration.config.ts
bun run node_modules/typescript/bin/tsc -p checks/tsconfig-assistant.json
bun run node_modules/typescript/bin/tsc -p checks/tsconfig-file-checks.json
bun run build
```

Use synthetic fixtures and an environment without live analytics/provider
credentials. These checks do not start the bot or enable a rendered browser.
The real Chromium worker and voice support are separate checkpoints.
