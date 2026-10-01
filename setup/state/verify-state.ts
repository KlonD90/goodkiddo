import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import { STORE_DIR } from '../../src/config/config.js';
import { readEnvFile } from '../../src/config/env.js';
import type { ServiceDef } from '../services/service-defs.js';
import type { ServiceCheck } from '../services/verify-services.js';

export type CredentialsStatus = 'configured' | 'missing';
export type VerifyStatus = 'success' | 'failed';

export interface RegisteredGroupsSummary {
  registeredGroups: number;
  groupsByAgent: Record<string, number>;
}

export interface VerifySummary extends RegisteredGroupsSummary {
  status: VerifyStatus;
  servicesSummary: Record<string, string>;
  configuredChannels: string[];
  channelAuth: Record<string, string>;
  codexConfigured: boolean;
  reviewConfigured: boolean;
}

export function detectCredentials(projectRoot: string): CredentialsStatus {
  const envFile = path.join(projectRoot, '.env');
  if (!fs.existsSync(envFile)) {
    return 'missing';
  }

  const envContent = fs.readFileSync(envFile, 'utf-8');
  return /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(envContent)
    ? 'configured'
    : 'missing';
}

export function detectChannelAuth(
  envVars = readEnvFile(['DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']),
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const channelAuth: Record<string, string> = {};

  if (processEnv.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN) {
    channelAuth.discord = 'configured';
  }

  if (processEnv.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN) {
    channelAuth.telegram = 'configured';
  }

  return channelAuth;
}

export function loadRegisteredGroupsSummary(
  dbPath = path.join(STORE_DIR, 'messages.db'),
): RegisteredGroupsSummary {
  let registeredGroups = 0;
  const groupsByAgent: Record<string, number> = {};

  if (!fs.existsSync(dbPath)) {
    return { registeredGroups, groupsByAgent };
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as { count: number };
    registeredGroups = row.count;

    try {
      const rows = db
        .prepare(
          'SELECT agent_type, COUNT(*) as count FROM registered_groups GROUP BY agent_type',
        )
        .all() as { agent_type: string; count: number }[];
      for (const current of rows) {
        groupsByAgent[current.agent_type || 'unknown'] = current.count;
      }
    } catch {
      // agent_type column might not exist in older schema
    }

    db.close();
  } catch {
    // Table might not exist
  }

  return { registeredGroups, groupsByAgent };
}

export function buildVerifySummary(
  services: ServiceCheck[],
  serviceDefs: ServiceDef[],
  credentials: CredentialsStatus,
  channelAuth: Record<string, string>,
  registeredGroups: number,
  groupsByAgent: Record<string, number>,
): VerifySummary {
  const configuredChannels = Object.keys(channelAuth);
  const allConfiguredServicesRunning = services.every(
    (service) => service.status === 'running',
  );
  const codexConfigured = serviceDefs.some(
    (service) => service.kind === 'codex',
  );
  const reviewConfigured = serviceDefs.some(
    (service) => service.kind === 'review',
  );

  const status =
    allConfiguredServicesRunning &&
    credentials === 'configured' &&
    configuredChannels.length > 0 &&
    registeredGroups > 0
      ? 'success'
      : 'failed';

  const servicesSummary: Record<string, string> = {};
  for (const service of services) {
    servicesSummary[service.name] = service.status;
  }

  return {
    status,
    servicesSummary,
    configuredChannels,
    channelAuth,
    registeredGroups,
    groupsByAgent,
    codexConfigured,
    reviewConfigured,
  };
}
