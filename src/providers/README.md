# Providers

This folder owns model/provider selection, auth routing, token rotation, and provider-specific recovery logic.

## Main Files

- `credential-providers.ts` - provider registry and model-to-provider resolution
- `credential-proxy.ts` - credential-injecting upstream proxy for isolated runtimes
- `provider-retry.ts` - retry loop helpers for provider failures
- `streamed-output-evaluator.ts` - interprets streamed outputs for retry/failover triggers
- `token-refresh.ts` - refreshes Claude OAuth tokens before expiry
- `token-rotation.ts` - Claude account rotation
- `codex-token-rotation.ts` - Codex account rotation
- `moa.ts` - mixture-of-agents reference model querying

## Start Here

1. `credential-providers.ts`
2. `credential-proxy.ts`
3. `provider-retry.ts`
4. `streamed-output-evaluator.ts`

## Boundaries

- Do not put owner/reviewer room policy here; that belongs in `../paired/`
- Do not put runner bootstrap here; that belongs in `../agents/`
- Do put new provider configuration and model-routing logic here
