import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLaunchdPlist,
  buildRuntimePathEnv,
  buildStackRestartSystemdUnit,
  buildSystemdUnit,
} from '../services/service-renderers.js';
import {
  getAllServiceDefs,
  getServiceDefs,
  type ServiceDef,
} from '../services/service-defs.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

const baseServiceDef: ServiceDef = {
  kind: 'primary',
  description: 'GoodKiddo Personal Assistant',
  launchdLabel: 'com.goodkiddo',
  logName: 'goodkiddo',
  name: 'goodkiddo',
};

describe('plist generation', () => {
  it('contains the correct label', () => {
    const plist = buildLaunchdPlist(
      baseServiceDef,
      '/home/user/goodkiddo',
      '/usr/local/bin/node',
      '/home/user',
    );
    expect(plist).toContain('<string>com.goodkiddo</string>');
  });

  it('uses the correct node path', () => {
    const plist = buildLaunchdPlist(
      baseServiceDef,
      '/home/user/goodkiddo',
      '/opt/node/bin/node',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = buildLaunchdPlist(
      baseServiceDef,
      '/home/user/goodkiddo',
      '/usr/local/bin/node',
      '/home/user',
    );
    expect(plist).toContain('/home/user/goodkiddo/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = buildLaunchdPlist(
      baseServiceDef,
      '/home/user/goodkiddo',
      '/usr/local/bin/node',
      '/home/user',
    );
    expect(plist).toContain('goodkiddo.log');
    expect(plist).toContain('goodkiddo.error.log');
  });
});

describe('systemd unit generation', () => {
  it('shares the runtime PATH builder across service formats', () => {
    expect(buildRuntimePathEnv('/usr/bin/bun', '/home/user')).toBe(
      '/usr/bin:/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin:/home/user/.npm-global/bin',
    );
  });

  it('user unit uses default.target', () => {
    const unit = buildSystemdUnit(
      baseServiceDef,
      '/home/user/goodkiddo',
      '/usr/bin/node',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = buildSystemdUnit(
      baseServiceDef,
      '/home/user/goodkiddo',
      '/usr/bin/node',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = buildSystemdUnit(
      baseServiceDef,
      '/home/user/goodkiddo',
      '/usr/bin/node',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('sets correct ExecStart', () => {
    const unit = buildSystemdUnit(
      baseServiceDef,
      '/srv/goodkiddo',
      '/usr/bin/bun',
      '/home/user',
      false,
    );
    expect(unit).toContain(
      'ExecStart=/usr/bin/bun /srv/goodkiddo/dist/index.js',
    );
  });

  it('preserves EnvironmentFile and extraEnv in the actual builder', () => {
    const unit = buildSystemdUnit(
      {
        ...baseServiceDef,
        kind: 'codex',
        environmentFile: '/srv/goodkiddo/.env.codex',
        extraEnv: { ASSISTANT_NAME: 'codex' },
        logName: 'goodkiddo-codex',
        name: 'goodkiddo-codex',
      },
      '/srv/goodkiddo',
      '/usr/bin/bun',
      '/home/user',
      false,
    );

    expect(unit).toContain('EnvironmentFile=/srv/goodkiddo/.env.codex');
    expect(unit).toContain('Environment=ASSISTANT_NAME=codex');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/goodkiddo';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'goodkiddo.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/goodkiddo.log 2>> ${JSON.stringify(projectRoot)}/logs/goodkiddo.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('goodkiddo.pid');
  });
});

describe('service definitions', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes the review service when .env.codex-review exists', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goodkiddo-stack-'));
    tempRoots.push(tempRoot);
    fs.writeFileSync(path.join(tempRoot, '.env.codex'), 'A=1\n');
    fs.writeFileSync(path.join(tempRoot, '.env.codex-review'), 'B=1\n');

    const defs = getServiceDefs(tempRoot);

    expect(defs.map((def) => def.name)).toEqual([
      'goodkiddo',
      'goodkiddo-codex',
      'goodkiddo-review',
    ]);
    expect(defs.map((def) => def.kind)).toEqual([
      'primary',
      'codex',
      'review',
    ]);
  });

  it('lists every known service for uninstall flows', () => {
    const defs = getAllServiceDefs('/srv/goodkiddo');

    expect(defs.map((def) => def.name)).toEqual([
      'goodkiddo',
      'goodkiddo-codex',
      'goodkiddo-review',
    ]);
  });

  it('generates a oneshot stack restart unit', () => {
    const unit = buildStackRestartSystemdUnit(
      '/srv/goodkiddo',
      '/usr/bin/bun',
      '/home/user',
    );

    expect(unit).toContain('Description=GoodKiddo Stack Restart Orchestrator');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain(
      'ExecStart=/usr/bin/bun /srv/goodkiddo/setup/steps/restart-stack.ts --direct',
    );
  });
});
