# execution

Sandbox-side validation and orchestration. Sits *inside* the tool — runs after the permissions guard has approved a call.

- `manifest.ts` — builds and validates the internal execution manifest; enforces `ExecutionPolicy` (allowed task types, runtime extensions) and rejects path traversal
- `orchestrator.ts` — drives the sandbox, scans output artifacts for PII, returns results
- `schemas.ts` — Zod schemas for tool inputs and the internal manifest
