import { describe, expect, it } from 'vitest';

import {
  buildCredentialProviderRegistry,
  detectProviderAuthMode,
  inferProviderIdForModel,
  resolveProviderAuth,
  resolveProviderIdForRequest,
} from './credential-providers.js';

function createEnv(values: Record<string, string | undefined>) {
  return (key: string): string | undefined => values[key];
}

describe('credential provider registry', () => {
  it('infers built-in providers from model names', () => {
    const registry = buildCredentialProviderRegistry(createEnv({}));

    expect(inferProviderIdForModel('claude-opus-4-1', registry)).toBe(
      'anthropic',
    );
    expect(inferProviderIdForModel('gpt-5.4', registry)).toBe('openai');
    expect(inferProviderIdForModel('o4-mini', registry)).toBe('openai');
  });

  it('honors explicit model-to-provider mappings', () => {
    const registry = buildCredentialProviderRegistry(
      createEnv({
        GOODKIDDO_CREDENTIAL_PROXY_PROVIDERS: 'moonshot',
        GOODKIDDO_PROVIDER_MOONSHOT_BASE_URL: 'https://api.moonshot.example',
        GOODKIDDO_PROVIDER_MOONSHOT_AUTH_ENV_KEYS: 'MOONSHOT_API_KEY',
        GOODKIDDO_PROVIDER_MOONSHOT_MODELS: 'kimi-k2',
        GOODKIDDO_MODEL_PROVIDER_MAP: 'kimi-special=moonshot',
      }),
    );

    expect(inferProviderIdForModel('kimi-special', registry)).toBe('moonshot');
    expect(inferProviderIdForModel('kimi-k2', registry)).toBe('moonshot');
  });

  it('resolves request provider from model before path', () => {
    const registry = buildCredentialProviderRegistry(createEnv({}));

    expect(
      resolveProviderIdForRequest({
        model: 'gpt-5.4',
        path: '/v1/messages',
        registry,
      }),
    ).toBe('openai');
  });

  it('supports custom providers with prefix-based model routing', () => {
    const registry = buildCredentialProviderRegistry(
      createEnv({
        GOODKIDDO_CREDENTIAL_PROXY_PROVIDERS: 'moonshot',
        GOODKIDDO_PROVIDER_MOONSHOT_BASE_URL: 'https://api.moonshot.example',
        GOODKIDDO_PROVIDER_MOONSHOT_AUTH_ENV_KEYS: 'MOONSHOT_API_KEY',
        GOODKIDDO_PROVIDER_MOONSHOT_MODEL_PREFIXES: 'kimi-',
      }),
    );

    expect(inferProviderIdForModel('kimi-k2-instruct', registry)).toBe(
      'moonshot',
    );
  });
});

describe('credential provider auth', () => {
  it('prefers anthropic api-key auth when available', () => {
    const env = createEnv({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
    });
    const registry = buildCredentialProviderRegistry(env);
    const auth = resolveProviderAuth(registry.providers.get('anthropic')!, env);

    expect(auth).toMatchObject({
      mode: 'api-key',
      envKey: 'ANTHROPIC_API_KEY',
      token: 'sk-ant-test',
      headerName: 'x-api-key',
    });
  });

  it('falls back to anthropic oauth when api-key is absent', () => {
    const env = createEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
    });
    const registry = buildCredentialProviderRegistry(env);

    expect(detectProviderAuthMode('anthropic', env)).toBe('oauth');
    expect(
      resolveProviderAuth(registry.providers.get('anthropic')!, env),
    ).toMatchObject({
      mode: 'oauth',
      envKey: 'CLAUDE_CODE_OAUTH_TOKEN',
      token: 'oauth-test',
      headerName: 'authorization',
      scheme: 'Bearer',
    });
  });
});
