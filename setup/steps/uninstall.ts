/**
 * Step: uninstall — Stop and remove generated service manager config.
 */
import os from 'os';

import { logger } from '../../src/config/logger.js';
import { emitStatus } from '../cli/status.js';
import { SetupStepError } from '../cli/setup-error.js';
import { getPlatform, getNodePath, type Platform } from '../platform/platform.js';
import { getAllServiceDefs } from '../services/service-defs.js';
import { uninstallLaunchd, uninstallLinux } from '../services/service-installers.js';

interface UninstallDeps {
  getPlatformImpl?: () => Platform;
  getHomeDir?: () => string;
  getProjectRoot?: () => string;
  uninstallLaunchdImpl?: typeof uninstallLaunchd;
  uninstallLinuxImpl?: typeof uninstallLinux;
}

export async function run(
  _args: string[],
  deps: UninstallDeps = {},
): Promise<void> {
  const projectRoot = deps.getProjectRoot?.() ?? process.cwd();
  const platform = deps.getPlatformImpl?.() ?? getPlatform();
  const nodePath = getNodePath();
  const homeDir = deps.getHomeDir?.() ?? os.homedir();
  const serviceDefs = getAllServiceDefs(projectRoot);
  const uninstallLaunchdImpl =
    deps.uninstallLaunchdImpl ?? uninstallLaunchd;
  const uninstallLinuxImpl = deps.uninstallLinuxImpl ?? uninstallLinux;

  logger.info({ platform, projectRoot }, 'Uninstalling GoodKiddo services');

  if (platform === 'macos') {
    for (const def of serviceDefs) {
      uninstallLaunchdImpl(def, homeDir);
      emitStatus('UNINSTALL_SERVICE', {
        SERVICE_NAME: def.name,
        SERVICE_TYPE: 'launchd',
        NODE_PATH: nodePath,
        PROJECT_PATH: projectRoot,
        STATUS: 'success',
        LOG: 'logs/setup.log',
      });
    }
    return;
  }

  if (platform === 'linux') {
    uninstallLinuxImpl(serviceDefs, projectRoot, homeDir);
    for (const def of serviceDefs) {
      emitStatus('UNINSTALL_SERVICE', {
        SERVICE_NAME: def.name,
        SERVICE_TYPE: 'linux',
        NODE_PATH: nodePath,
        PROJECT_PATH: projectRoot,
        STATUS: 'success',
        LOG: 'logs/setup.log',
      });
    }
    return;
  }

  emitStatus('UNINSTALL_SERVICE', {
    SERVICE_TYPE: 'unknown',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    STATUS: 'failed',
    ERROR: 'unsupported_platform',
    LOG: 'logs/setup.log',
  });
  throw new SetupStepError('unsupported_platform');
}

export const _testing = {
  run,
};
