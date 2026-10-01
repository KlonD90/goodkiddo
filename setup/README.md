# Setup

Quick guide to the `setup/` subtree. The main repo docs belong in the main README.

## What Lives Here

- `cli/` — setup entrypoint, prompt helpers, status output
- `steps/` — user-facing setup commands
- `services/` — service defs, renderers, installers, service checks
- `platform/` — OS/platform helpers
- `state/` — setup-state summaries used by verify and onboarding

## When Troubleshooting

- setup command flow: `steps/`
- service generation or install issues: `services/`
- OS-specific behavior: `platform/`
- missing or misdetected config: `state/`
- prompt or wizard behavior: `cli/`

## Start Points

- `steps/wizard.ts`
- `steps/register.ts`
- `steps/service.ts`
- `steps/uninstall.ts`
- `steps/verify.ts`

## Quick Check

```bash
bun run test -- setup/steps/environment.test.ts setup/steps/register.test.ts setup/steps/service.test.ts setup/steps/uninstall.test.ts setup/services/verify-services.test.ts setup/state/verify-state.test.ts setup/steps/wizard.test.ts
bun run typecheck
```
