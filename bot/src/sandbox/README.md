# sandbox

Sandbox backend implementations.

- `factory.ts` — picks Docker (default) or Firecracker if `/dev/kvm` is available
- `docker_backend.ts` — runs the manifest in a temporary container; supports `--network none`
- `firecracker_backend.ts` — microVM backend (opt-in)
- `types.ts` — `SandboxBackend` interface used by `execution/orchestrator.ts`
