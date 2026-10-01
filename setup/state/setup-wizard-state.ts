import { readEnvFile } from '../../src/config/env.js';
import { getServiceManager } from '../platform/platform.js';
import { getServiceDefs } from '../services/service-defs.js';
import { getServiceChecks, type ServiceCheck } from '../services/verify-services.js';
import {
  detectChannelAuth,
  detectCredentials,
  loadRegisteredGroupsSummary,
} from './verify-state.js';

export type SetupChannelKind = 'discord' | 'telegram';
export type CredentialKind = 'claude-code-oauth-token' | 'anthropic-api-key';

export interface SetupWizardEnvValues {
  assistantName: string;
  discordToken: string;
  telegramToken: string;
  claudeCodeOauthToken: string;
  anthropicApiKey: string;
}

export interface SetupWizardState {
  env: SetupWizardEnvValues;
  credentialsConfigured: boolean;
  credentialKind: CredentialKind | null;
  configuredChannels: SetupChannelKind[];
  registeredGroups: number;
  groupsByAgent: Record<string, number>;
  serviceChecks: ServiceCheck[];
  needsCredentials: boolean;
  needsChannel: boolean;
  needsRegistration: boolean;
  needsServiceSetup: boolean;
}

function detectCredentialKind(env: SetupWizardEnvValues): CredentialKind | null {
  if (env.claudeCodeOauthToken) {
    return 'claude-code-oauth-token';
  }
  if (env.anthropicApiKey) {
    return 'anthropic-api-key';
  }
  return null;
}

function sortConfiguredChannels(channels: string[]): SetupChannelKind[] {
  return channels
    .filter(
      (channel): channel is SetupChannelKind =>
        channel === 'discord' || channel === 'telegram',
    )
    .sort((left, right) => left.localeCompare(right));
}

export function loadSetupWizardState(
  projectRoot = process.cwd(),
): SetupWizardState {
  const envVars = readEnvFile([
    'ASSISTANT_NAME',
    'DISCORD_BOT_TOKEN',
    'TELEGRAM_BOT_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ]);
  const env: SetupWizardEnvValues = {
    assistantName: envVars.ASSISTANT_NAME || '',
    discordToken: envVars.DISCORD_BOT_TOKEN || '',
    telegramToken: envVars.TELEGRAM_BOT_TOKEN || '',
    claudeCodeOauthToken: envVars.CLAUDE_CODE_OAUTH_TOKEN || '',
    anthropicApiKey: envVars.ANTHROPIC_API_KEY || '',
  };
  const credentialsConfigured = detectCredentials(projectRoot) === 'configured';
  const configuredChannels = sortConfiguredChannels(
    Object.keys(detectChannelAuth(envVars)),
  );
  const { registeredGroups, groupsByAgent } = loadRegisteredGroupsSummary();
  const serviceChecks = getServiceChecks(
    getServiceDefs(projectRoot),
    projectRoot,
    getServiceManager(),
  );

  return {
    env,
    credentialsConfigured,
    credentialKind: detectCredentialKind(env),
    configuredChannels,
    registeredGroups,
    groupsByAgent,
    serviceChecks,
    needsCredentials: !credentialsConfigured,
    needsChannel: configuredChannels.length === 0,
    needsRegistration: registeredGroups === 0,
    needsServiceSetup: serviceChecks.some((service) => service.status !== 'running'),
  };
}

export function buildSetupWizardStatusLines(
  state: SetupWizardState,
): string[] {
  return [
    `- Assistant name: ${state.env.assistantName || 'missing'}`,
    `- Credentials: ${state.credentialsConfigured ? 'configured' : 'missing'}`,
    `- Channels: ${
      state.configuredChannels.length > 0
        ? state.configuredChannels.join(', ')
        : 'none configured'
    }`,
    `- Registered rooms: ${state.registeredGroups}`,
    `- Services: ${
      state.serviceChecks.length > 0
        ? state.serviceChecks
            .map((service) => `${service.name}=${service.status}`)
            .join(', ')
        : 'none detected'
    }`,
  ];
}
