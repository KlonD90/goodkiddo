import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServiceDef } from './service-defs.js';

describe('verify service checks', () => {
  let execSyncMock: ReturnType<typeof vi.fn>;
  let isRootMock: ReturnType<typeof vi.fn>;
  let verifyServices: typeof import('./verify-services.js');

  beforeEach(async () => {
    vi.resetModules();
    execSyncMock = vi.fn();
    isRootMock = vi.fn(() => false);

    vi.doMock('child_process', () => ({
      execSync: execSyncMock,
    }));

    vi.doMock('../platform/platform.js', () => ({
      isRoot: isRootMock,
    }));

    verifyServices = await import('./verify-services.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('treats launchd entries with a PID as running', () => {
    execSyncMock.mockReturnValue('123\t0\tcom.goodkiddo\n');

    expect(verifyServices.checkLaunchdService('com.goodkiddo')).toBe('running');
  });

  it('treats launchd entries without a PID as stopped', () => {
    execSyncMock.mockReturnValue('-\t0\tcom.goodkiddo\n');

    expect(verifyServices.checkLaunchdService('com.goodkiddo')).toBe('stopped');
  });

  it('checks systemd user services with the user prefix', () => {
    isRootMock.mockReturnValue(false);
    execSyncMock.mockReturnValue(undefined);

    expect(verifyServices.checkSystemdService('goodkiddo')).toBe('running');
    expect(execSyncMock).toHaveBeenCalledWith('systemctl --user is-active goodkiddo', {
      stdio: 'ignore',
    });
  });

  it('treats known but inactive systemd services as stopped', () => {
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('inactive');
      })
      .mockReturnValueOnce('goodkiddo.service enabled\n');

    expect(verifyServices.checkSystemdService('goodkiddo')).toBe('stopped');
  });

  it('treats a live nohup PID as running', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goodkiddo-verify-'));
    const pidFile = path.join(tempRoot, 'goodkiddo.pid');
    fs.writeFileSync(pidFile, '12345\n');

    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid: number, _signal?: number | NodeJS.Signals) => true);

    expect(verifyServices.checkNohupService(tempRoot, 'goodkiddo')).toBe('running');

    killSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('builds per-service status checks from service definitions', () => {
    const defs: ServiceDef[] = [
      {
        kind: 'primary',
        name: 'goodkiddo',
        description: 'GoodKiddo',
        launchdLabel: 'com.goodkiddo',
        logName: 'goodkiddo',
      },
      {
        kind: 'codex',
        name: 'goodkiddo-codex',
        description: 'Codex',
        launchdLabel: 'com.goodkiddo.codex',
        logName: 'goodkiddo-codex',
      },
    ];
    execSyncMock.mockReturnValue('123\t0\tcom.goodkiddo\n');

    expect(verifyServices.getServiceChecks(defs, '/tmp/goodkiddo', 'launchd')).toEqual([
      { name: 'goodkiddo', status: 'running' },
      { name: 'goodkiddo-codex', status: 'not_found' },
    ]);
  });
});
