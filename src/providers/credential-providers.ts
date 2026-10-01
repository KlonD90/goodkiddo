import { getEnv } from '../config/env.js';
import type { AgentType } from '../shared/types.js';

export type ProviderAuthMode = 'api-key' | 'oauth' | 'bearer' | 'none';

export interface ProviderAuthStrategy {
  mode: Exclude<ProviderAuthMode, 'none'>;
  envKeys: string[];
  headerName: string;
  scheme?: string;
}

export interface CredentialProviderDefinition {
  id: string;
  baseUrl: string;
  authStrategies: ProviderAuthStrategy[];
  modelNames: string[];
  modelPrefixes: string[];
  pathPrefixes: string[];
  defaultForAgentTypes: AgentType[];
}

export interface CredentialProviderRegistry {
  providers: Map<string, CredentialProviderDefinition>;
  defaultProviderId?: string;
  exactModelMap: Map<string, string>;
  prefixModelMap: Array<{ prefix: string; providerId: string }>;
}

export interface ResolvedProviderAuth {
  mode: Exclude<ProviderAuthMode, 'none'>;
  token: string;
  envKey: string;
  headerName: string;
  scheme?: string;
}

type EnvReader = (key: string) => string | undefined;

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeProviderId(value?: string): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function toEnvToken(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

function parseModelMap(
  value: string | undefined,
  normalizeKey: (value: string) => string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of splitCsv(value)) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = normalizeKey(entry.slice(0, separatorIndex).trim());
    const providerId = normalizeProviderId(entry.slice(separatorIndex + 1));
    if (!key || !providerId) continue;
    result.set(key, providerId);
  }
  return result;
}

function parsePrefixModelMap(
  value: string | undefined,
): Array<{ prefix: string; providerId: string }> {
  const result: Array<{ prefix: string; providerId: string }> = [];
  for (const entry of splitCsv(value)) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) continue;
    const prefix = entry.slice(0, separatorIndex).trim().toLowerCase();
    const providerId = normalizeProviderId(entry.slice(separatorIndex + 1));
    if (!prefix || !providerId) continue;
    result.push({ prefix, providerId });
  }
  return result;
}

function buildBuiltinProviders(
  readEnv: EnvReader,
): CredentialProviderDefinition[] {
  return [
    {
      id: 'anthropic',
      baseUrl: readEnv('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com',
      authStrategies: [
        {
          mode: 'api-key',
          envKeys: ['ANTHROPIC_API_KEY'],
          headerName: 'x-api-key',
        },
        {
          mode: 'oauth',
          envKeys: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
          headerName: 'authorization',
          scheme: 'Bearer',
        },
      ],
      modelNames: splitCsv(readEnv('GOODKIDDO_PROVIDER_ANTHROPIC_MODELS')),
      modelPrefixes: [
        'claude',
        ...splitCsv(readEnv('GOODKIDDO_PROVIDER_ANTHROPIC_MODEL_PREFIXES')).map(
          (prefix) => prefix.toLowerCase(),
        ),
      ],
      pathPrefixes: [
        '/v1/messages',
        '/v1/complete',
        '/v1/complete_stream',
        '/api/oauth',
        ...splitCsv(readEnv('GOODKIDDO_PROVIDER_ANTHROPIC_PATH_PREFIXES')),
      ],
      defaultForAgentTypes: ['claude-code'],
    },
    {
      id: 'openai',
      baseUrl: readEnv('OPENAI_BASE_URL') || 'https://api.openai.com',
      authStrategies: [
        {
          mode: 'bearer',
          envKeys: ['OPENAI_API_KEY'],
          headerName: 'authorization',
          scheme: 'Bearer',
        },
      ],
      modelNames: splitCsv(readEnv('GOODKIDDO_PROVIDER_OPENAI_MODELS')),
      modelPrefixes: [
        'gpt-',
        'o1',
        'o3',
        'o4',
        'o5',
        'text-embedding-',
        'text-moderation-',
        ...splitCsv(readEnv('GOODKIDDO_PROVIDER_OPENAI_MODEL_PREFIXES')).map(
          (prefix) => prefix.toLowerCase(),
        ),
      ],
      pathPrefixes: [
        '/v1/chat/completions',
        '/v1/responses',
        '/v1/embeddings',
        '/v1/audio',
        '/v1/images',
        '/v1/moderations',
        ...splitCsv(readEnv('GOODKIDDO_PROVIDER_OPENAI_PATH_PREFIXES')),
      ],
      defaultForAgentTypes: ['codex'],
    },
  ];
}

function buildCustomProvider(
  providerId: string,
  readEnv: EnvReader,
): CredentialProviderDefinition | null {
  const envPrefix = `GOODKIDDO_PROVIDER_${toEnvToken(providerId)}`;
  const baseUrl = readEnv(`${envPrefix}_BASE_URL`);
  if (!baseUrl) return null;

  const authModeRaw = (readEnv(`${envPrefix}_AUTH_MODE`) || 'bearer')
    .trim()
    .toLowerCase();
  const authMode =
    authModeRaw === 'api-key' ||
    authModeRaw === 'oauth' ||
    authModeRaw === 'bearer'
      ? authModeRaw
      : 'bearer';
  const authHeaderName =
    readEnv(`${envPrefix}_AUTH_HEADER`) ||
    (authMode === 'api-key' ? 'x-api-key' : 'authorization');
  const authScheme =
    authMode === 'api-key'
      ? undefined
      : readEnv(`${envPrefix}_AUTH_SCHEME`) || 'Bearer';
  const authEnvKeys = splitCsv(readEnv(`${envPrefix}_AUTH_ENV_KEYS`));

  return {
    id: providerId,
    baseUrl,
    authStrategies:
      authEnvKeys.length > 0
        ? [
            {
              mode: authMode,
              envKeys: authEnvKeys,
              headerName: authHeaderName,
              ...(authScheme ? { scheme: authScheme } : {}),
            },
          ]
        : [],
    modelNames: splitCsv(readEnv(`${envPrefix}_MODELS`)),
    modelPrefixes: splitCsv(readEnv(`${envPrefix}_MODEL_PREFIXES`)).map(
      (prefix) => prefix.toLowerCase(),
    ),
    pathPrefixes: splitCsv(readEnv(`${envPrefix}_PATH_PREFIXES`)),
    defaultForAgentTypes: splitCsv(readEnv(`${envPrefix}_AGENT_TYPES`)).filter(
      (value): value is AgentType =>
        value === 'claude-code' || value === 'codex',
    ),
  };
}

export function buildCredentialProviderRegistry(
  readEnv: EnvReader = getEnv,
): CredentialProviderRegistry {
  const providers = new Map<string, CredentialProviderDefinition>();

  for (const provider of buildBuiltinProviders(readEnv)) {
    providers.set(provider.id, provider);
  }

  for (const providerId of splitCsv(
    readEnv('GOODKIDDO_CREDENTIAL_PROXY_PROVIDERS'),
  )
    .map(normalizeProviderId)
    .filter((value): value is string => Boolean(value))) {
    if (providers.has(providerId)) continue;
    const provider = buildCustomProvider(providerId, readEnv);
    if (provider) {
      providers.set(provider.id, provider);
    }
  }

  const defaultProviderId =
    normalizeProviderId(readEnv('GOODKIDDO_DEFAULT_PROVIDER')) ||
    (providers.has('anthropic')
      ? 'anthropic'
      : providers.keys().next().value || undefined);

  return {
    providers,
    defaultProviderId,
    exactModelMap: parseModelMap(
      readEnv('GOODKIDDO_MODEL_PROVIDER_MAP'),
      (value) => value.toLowerCase(),
    ),
    prefixModelMap: parsePrefixModelMap(
      readEnv('GOODKIDDO_MODEL_PROVIDER_PREFIX_MAP'),
    ),
  };
}

export function resolveProviderAuth(
  provider: CredentialProviderDefinition,
  readEnv: EnvReader = getEnv,
): ResolvedProviderAuth | null {
  for (const strategy of provider.authStrategies) {
    for (const envKey of strategy.envKeys) {
      const token = readEnv(envKey);
      if (!token) continue;
      return {
        mode: strategy.mode,
        token,
        envKey,
        headerName: strategy.headerName,
        scheme: strategy.scheme,
      };
    }
  }
  return null;
}

export function detectProviderAuthMode(
  providerId: string,
  readEnv: EnvReader = getEnv,
): ProviderAuthMode {
  const provider =
    buildCredentialProviderRegistry(readEnv).providers.get(providerId);
  if (!provider) return 'none';
  return resolveProviderAuth(provider, readEnv)?.mode || 'none';
}

export function inferProviderIdForModel(
  model: string | undefined,
  registry: CredentialProviderRegistry,
): string | undefined {
  const normalizedModel = model?.trim().toLowerCase();
  if (!normalizedModel) return undefined;

  const exactMatch = registry.exactModelMap.get(normalizedModel);
  if (exactMatch && registry.providers.has(exactMatch)) {
    return exactMatch;
  }

  for (const [providerId, provider] of registry.providers) {
    if (
      provider.modelNames.some(
        (value) => value.toLowerCase() === normalizedModel,
      )
    ) {
      return providerId;
    }
  }

  for (const { prefix, providerId } of registry.prefixModelMap) {
    if (
      normalizedModel.startsWith(prefix) &&
      registry.providers.has(providerId)
    ) {
      return providerId;
    }
  }

  for (const [providerId, provider] of registry.providers) {
    if (
      provider.modelPrefixes.some((prefix) =>
        normalizedModel.startsWith(prefix.toLowerCase()),
      )
    ) {
      return providerId;
    }
  }

  return undefined;
}

export function resolveProviderIdForAgentType(
  agentType: AgentType,
  registry: CredentialProviderRegistry,
): string | undefined {
  for (const [providerId, provider] of registry.providers) {
    if (provider.defaultForAgentTypes.includes(agentType)) {
      return providerId;
    }
  }
  return undefined;
}

export function resolveProviderIdForRequest(args: {
  providerId?: string;
  model?: string;
  path?: string;
  agentType?: AgentType;
  registry: CredentialProviderRegistry;
}): string | undefined {
  const explicitProviderId = normalizeProviderId(args.providerId);
  if (explicitProviderId && args.registry.providers.has(explicitProviderId)) {
    return explicitProviderId;
  }

  const providerFromModel = inferProviderIdForModel(args.model, args.registry);
  if (providerFromModel) return providerFromModel;

  const requestPath = args.path || '';
  if (requestPath) {
    for (const [providerId, provider] of args.registry.providers) {
      if (
        provider.pathPrefixes.some((prefix) => requestPath.startsWith(prefix))
      ) {
        return providerId;
      }
    }
  }

  if (args.agentType) {
    const providerFromAgentType = resolveProviderIdForAgentType(
      args.agentType,
      args.registry,
    );
    if (providerFromAgentType) return providerFromAgentType;
  }

  return args.registry.defaultProviderId;
}
