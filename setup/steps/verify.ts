/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Supports the GoodKiddo service stack:
 *   - goodkiddo (Claude Code) — always checked
 *   - goodkiddo-codex (Codex) — checked when .env.codex exists
 *   - goodkiddo-review (Codex Review) — checked when .env.codex-review exists
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import { logger } from '../../src/config/logger.js';
import { getServiceManager } from '../platform/platform.js';
import { getServiceDefs } from '../services/service-defs.js';
import { emitStatus } from '../cli/status.js';
import { SetupStepError } from '../cli/setup-error.js';
import {
  buildVerifySummary,
  detectChannelAuth,
  detectCredentials,
  loadRegisteredGroupsSummary,
} from '../state/verify-state.js';
import { getServiceChecks } from '../services/verify-services.js';

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const mgr = getServiceManager();

  logger.info('Starting verification');

  // 1. Check service statuses
  const serviceDefs = getServiceDefs(projectRoot);
  const services = getServiceChecks(serviceDefs, projectRoot, mgr);

  for (const svc of services) {
    logger.info({ service: svc.name, status: svc.status }, 'Service status');
  }

  const credentials = detectCredentials(projectRoot);
  const channelAuth = detectChannelAuth();
  const { registeredGroups, groupsByAgent } = loadRegisteredGroupsSummary();
  const {
    status,
    servicesSummary,
    configuredChannels,
    codexConfigured,
    reviewConfigured,
  } = buildVerifySummary(
    services,
    serviceDefs,
    credentials,
    channelAuth,
    registeredGroups,
    groupsByAgent,
  );

  logger.info({ status, channelAuth, servicesSummary }, 'Verification complete');

  emitStatus('VERIFY', {
    SERVICES: JSON.stringify(servicesSummary),
    // Legacy field (keep for backward compatibility)
    SERVICE: services[0].status,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    GROUPS_BY_AGENT: JSON.stringify(groupsByAgent),
    CODEX_CONFIGURED: codexConfigured,
    REVIEW_CONFIGURED: reviewConfigured,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') {
    throw new SetupStepError('verification_failed');
  }
}
